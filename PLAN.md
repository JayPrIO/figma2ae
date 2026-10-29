# Figma → After Effects Bridge — Implementation Plan

Product name: **Figma2AE**. Bundle id: `io.jaypr.figma2ae`. Version line: `1.x`.
Target: macOS Apple Silicon, After Effects 2023 (23.0)+ (needs `Layer.setTrackMatte`), Figma desktop + browser.
Newer AE features are feature-detected (`app.fonts` 24.0+, `TextDocument.characterRange` 24.3+).
Distribution: GitHub Releases (manual zip install). CI/CD: GitHub Actions.

Inspiration: AEUX (Figma plugin → JSON → AE CEP panel → ExtendScript builder) and
Overlord (persistent live connection, fast batched builds). Receiving end lives
**inside After Effects** (CEP panel with embedded Node) — no separate daemon.

---

## 1. Architecture

```
┌──────────── Figma ────────────┐        ┌──────────────── After Effects ────────────────┐
│ main thread (code.js)         │        │ CEP panel (Chromium + Node, mixed context)    │
│  • traverse selection         │        │  • bridge-server (ws on 127.0.0.1/::1:7741+)  │
│  • absolute→root transforms   │ post   │  • asset store (~/Library/Caches/Figma2AE)    │
│  • SVG path → AE bezier       │ Message│  • build queue (serial; AE is single threaded) │
│  • text segments / images     │──────▶ │  • writes doc JSON to tmp file                │
│ UI iframe (ui.html, Preact)   │  WS    │  • evalScript("F2AE.buildFromFile(...)")      │
│  • Sync / Break Apart / opts  │══════▶ │             │                                 │
│  • ws client, backoff, hb     │        │             ▼                                 │
└───────────────────────────────┘        │ ExtendScript (f2ae.jsx, ES3)                   │
                                         │  • JSON tree → comps / shape / text / image    │
                                         │  • break-apart vs group, anchors, parenting    │
                                         └───────────────────────────────────────────────┘
```

Repository layout (npm workspaces):

| Path              | Package               | Role |
|-------------------|-----------------------|------|
| `/shared`         | `@f2ae/shared`        | Schema types, wire protocol, matrix math, path math. **ES5-safe TS subset** (consumed by the ExtendScript build). |
| `/figma-plugin`   | `@f2ae/figma-plugin`  | Figma main-thread extractor + Preact UI (Vite, single-file HTML). |
| `/bridge-server`  | `@f2ae/bridge-server` | WebSocket relay library (protocol, asset dedupe, metrics, logging) + standalone dev CLI. Embedded by the AE panel. |
| `/ae-extension`   | `@f2ae/ae-extension`  | CEP panel (Node) + ExtendScript builder (TS → Babel → ES3 `.jsx`). |
| `/scripts`        | —                     | Build orchestration, packaging, install helper, Makefile targets. |

### Why the bridge lives in the panel
CEP ships Node; the panel owns the socket, so there is nothing extra to launch,
sign, or notarize. `/bridge-server` stays an independent, testable package and
also runs standalone (`npm run dev:bridge`) to test Figma without AE.

---

## 2. Wire protocol (v1)

Transport: WebSocket, `ws://localhost:{7741..7745}` (server takes first free
port; client scans the range). Server binds **127.0.0.1 and ::1** only.
Origin allowlist: `null` (Figma plugin iframe), `https://www.figma.com`,
absent (local dev tools). Anything else → HTTP 403 on upgrade.

Text frames (JSON):

| Dir | type | payload |
|-----|------|---------|
| C→S | `hello` | `{protocol:1, client:"figma", clientVersion}` |
| S→C | `welcome` | `{protocol:1, serverVersion, host:{app, version}}` |
| C→S | `sync.begin` | `{syncId, assets:[{hash, mime, size}]}` |
| S→C | `sync.need` | `{syncId, hashes:[...]}` (assets missing from the on-disk cache) |
| C→S | *(binary)* asset frames | `u32 headerLen` + header JSON `{syncId, hash, mime}` + bytes |
| C→S | `sync.commit` | `{syncId, document}` (F2AEDocument) |
| S→C | `sync.progress` | `{syncId, phase:"received"|"queued"|"building"}` |
| S→C | `sync.result` | `{syncId, ok, stats, warnings[], error?}` |
| S→C | `error` | `{code, message, syncId?}` |

Limits: max frame 256 MiB, max queued builds 4 (backpressure → `error BUSY`),
asset hash `^[a-f0-9]{8,64}$` (path-traversal guard), sync result timeout on
client 180 s. Heartbeat: client `ping` every 10 s; server drops sockets idle
for 30 s. Client reconnect: exponential backoff 250 ms → 8 s, full jitter.

Observability: `GET /health` (JSON) and `GET /metrics` (Prometheus text) on the
same port. Counters: connections, syncs ok/failed, bytes in, assets deduped.
Histograms (p50/p95/p99 via fixed buckets): receive latency, build latency.
Structured JSON-lines logs to `~/Library/Logs/Figma2AE/bridge.log`.

---

## 3. Document schema (v1) — `@f2ae/shared/schema`

- `F2AEDocument { schemaVersion:1, generator, options, roots: RootNode[], fonts[] }`
- `options { breakApart, clippedFramesAsPrecomps, includeHidden, target:"newComp"|"activeComp", imageScale }`
- Every node: `id, name, type, visible, opacity, blendMode, size{w,h}`,
  `transform: Mat2x3` **relative to the root** (root top-left = comp origin),
  computed from Figma `absoluteTransform` (already resolves nested Auto Layout).
- Node kinds: `container` (FRAME/GROUP/COMPONENT/INSTANCE/SECTION; `clips`,
  background fills/strokes, `children`), `shape` (geometry + fills + strokes),
  `text`, `raster` (rasterized fallback).
- Geometry: `rect{w,h,radius}` (uniform radius, no smoothing) | `ellipse{w,h}`
  (full ellipse) | `path{paths: BezierPath[]}` where `BezierPath {closed, v, i, o, fillRule}`
  — vertices + **relative** tangents in node-local space, ready for AE `Shape`.
- Paints: `solid{color, opacity}` | `linear|radial{stops, start, end, opacity}`
  (angular/diamond → radial + warning) | `image{hash, imageSize, placement Mat2x3, scaleMode}`.
- Strokes: `{paints, weight, align, cap, join, miterLimit, dash[], outline?: BezierPath[]}`
  (`outline` = Figma strokeGeometry, used when AE's centered stroke can't match).
- Effects: `dropShadow`, `innerShadow`, `layerBlur`, `backgroundBlur`.
- Masks: `isMask` + `maskType` (alpha/vector/luminance) on a sibling.
- Text: `characters, box{autoResize}, align{h,v}, segments[{start,end,font{family,style},
  size, lineHeight, letterSpacing, fill, decoration, case}]`, `paragraphSpacing`.

---

## 4. AE build semantics

Layer-space convention: every AE layer draws its node in **node-local**
coordinates (0..w, 0..h), anchor = node centre, so rotation/scale animate
naturally. Position/rotation/scale come from decomposing
`inverse(parentMatrix) · nodeMatrix` (QR decomposition; residual shear baked
into path vertices for shapes, warning for text/images).

- **Break Apart = ON**: one AE layer per node. Containers → Null (named after
  the frame) parenting their children; frame backgrounds → `"<name> ▸ bg"`
  shape layer. Clipping frames → nested precomp (default) or alpha track matte
  (`clippedFramesAsPrecomps=false`). Masks → track mattes (`setTrackMatte`
  on AE 23+, duplicated matte layers on older AE).
- **Break Apart = OFF**: each selected root becomes **one** shape layer whose
  contents mirror the hierarchy as nested shape groups (each with its own group
  transform); text and image nodes, which can't live in a shape layer, become
  separate layers parented to that group layer.
- Stacking: Figma children are bottom→top; AE `add*` inserts at index 1, so
  depth-first bottom→top creation yields correct order.
- Target: `newComp` = one comp per selected root (frame size, 30 fps, 10 s,
  inside a `Figma2AE` folder); `activeComp` = add into the active comp.
- Fills: AE shape fills in reverse Figma order (Figma last = top). Gradient colour
  stops are not scriptable in ExtendScript, so each gradient paint becomes its own
  shape layer: `G-Fill` (default white→black, exact start/end points, linear/radial)
  recoloured by a **Tritone** effect (highlights = first stop, midtones = 50 % sample,
  shadows = last stop — exact for 2-stop, close for 3+). Varying stop alpha adds a
  luma track matte (same ramp + Levels output range = alpha range).
- Grouped mode (Break Apart OFF) splits out only nodes that need layer-level
  features (text, images, gradients, effects, masks, clipping, blend modes) into
  their own layers, chunking the remaining vectors into as few shape layers as
  stacking order allows, all parented under one root null.
- Strokes: CENTER → native stroke; INSIDE/OUTSIDE on rect/ellipse → offset
  parametric geometry; otherwise outlined `strokeGeometry` as fill.
- Text: point text for `WIDTH_AND_HEIGHT`, box text otherwise; per-segment
  styling via `characterRange` (AE 24.3+), else dominant style + warning; font
  via `app.fonts` PostScript lookup with heuristic fallback.
- Images: imported once per hash (footage cache in a `Figma2AE/Assets` folder),
  placed with placement matrix, clipped by a layer mask in image pixel space.
- Effects: drop shadow → `ADBE Drop Shadow`; layer blur → `ADBE Gaussian Blur 2`;
  inner shadow/background blur → warning (layer styles aren't scriptable).
- Whole build = one undo group; per-node try/catch, failures become warnings.

---

## 5. Build & release

- `make build` → `scripts/build.mjs`: shared → bridge → figma plugin → AE
  panel + jsx → ES3 syntax gate (acorn `ecmaVersion:3`) → `dist/`.
- `make package` → `dist/release/Figma2AE-figma-plugin-vX.zip`,
  `Figma2AE-ae-extension-vX.zip` (includes `install.sh`).
- `make install-ae` → copies the panel to
  `~/Library/Application Support/Adobe/CEP/extensions/io.jaypr.figma2ae` and
  enables `PlayerDebugMode` for CSXS 9–12 (unsigned extension).
- CI (`.github/workflows/ci.yml`): typecheck, test, build on `macos-14` (arm64).
- Release (`.github/workflows/release.yml`): on tag `v*`, build + package +
  attach zips to a GitHub Release.

---

## 6. Milestones

- [x] **M0** Monorepo scaffold, tooling, PLAN.md
- [x] **M1** `@f2ae/shared`: schema, protocol, Mat2x3 math, SVG→bezier, tests + benchmarks
- [x] **M2** `@f2ae/bridge-server`: server, asset store, metrics, logging, CLI, tests
- [x] **M3** `@f2ae/figma-plugin`: extractor, transport client, Preact UI, tests
- [x] **M4** `@f2ae/ae-extension`: ES3 builder (jsx) + mocked-AE test harness
- [x] **M5** `@f2ae/ae-extension`: CEP panel (bridge host, asset store, evalScript)
- [x] **M6** Build scripts, packaging, Makefile, install helper
- [x] **M7** GitHub Actions CI + release, README
- [ ] **M8** Manual QA in real Figma + AE (see §7)

## 7. Manual QA checklist (cannot be automated without AE)
- [ ] Panel loads in AE 2024/2025 on Apple Silicon; `/health` reachable
- [ ] Figma plugin connects, reconnects after AE restart
- [ ] Break Apart ON/OFF on: nested auto layout, rotated groups, booleans,
      vector with open path, mixed-style text, image fills (fill/fit/crop),
      masks, clipped frames, drop shadow, gradient fills
- [x] Verify box-text placement and gradient colour scripting on real AE (AE 26.5, 2026-10-28)

## 8. Risks / known constraints
- Gradient colour stops are not scriptable on some AE builds → fallback.
- Box text placement relies on `TextDocument.boxTextPos` (fallback assumes centred box).
- Layer styles (inner shadow, stroke style) are not scriptable in ExtendScript.
- Unsigned CEP extensions require `PlayerDebugMode`; self-signed ZXP is a follow-up.
- Builder tests use a mocked AE DOM: proves logic + ES3 compatibility, not AE fidelity.

## 9. Implementation notes / metrics
- **M0** npm workspaces; TS 5.9 strict; Vitest 3; esbuild 0.25. Shared code consumed as TS source (no prebuild step).
- **M1** 39 tests. Benchmarks (M-series, Node 22): `parseSvgPath` ≈ 110 MB/s (216 KiB / 10k segments in 1.97 ms mean,
  p99 2.5 ms); matrix multiply+invert+decompose ≈ 12.7 M ops/s. Parser is single-pass char-code scanning, O(n),
  never throws (returns partial result + error). Validator is iterative (explicit stack) with depth/node caps.
- **M2** 17 tests (real sockets): origin allowlist (403), hello/protocol gating, asset SHA-1 integrity, content-addressed
  dedupe (2nd sync uploads 0 bytes), serial build queue (max concurrency verified = 1), backpressure (`BUSY`),
  idle-drop, port fallback. Binds 127.0.0.1 + ::1 (verified both). Commit awaits in-flight asset writes (no polling).
- **M3** 19 tests incl. E2E (UI transport ↔ real BridgeServer: port scan past dead port, upload, dedupe, fail-fast on
  disconnect + backoff reconnect). Provisional asset keys (`img:`/`ras:`) are rewritten to SHA-1 in the UI (crypto.subtle).
  Image fetch/export bounded to 4 concurrent. Offline fallback: `.f2ae.json` bundle (base64 assets) importable in the AE panel.
  Bundle sizes: `code.js` 20 KB, `ui.html` 31 KB (single file).
- **M4** 23 tests execute the *compiled* `f2ae.jsx` in a Node VM against a mocked AE DOM (JSON global removed to
  exercise the ExtendScript path). Core invariant tested by **re-projection**: every layer's layer→comp matrix is
  rebuilt from AE anchor/position/scale/rotation + parent chain and must map node-local corners onto Figma's
  coordinates (rotation, nested groups, shear baking, precomps, active-comp centring, image/raster placement).
  ES3 gate = acorn `ecmaVersion:3` + reserved-word property scan + forbidden ES5+ API scan + ASCII-only; jsx sources
  also typecheck against `lib: ES5`. Output 51 KiB. Pipeline: esbuild (ES2015 IIFE) → Babel preset-env loose (ie 9)
  + ES3 member/property/reserved-word plugins.
- **M5** CEP panel (CSXS 11, AEFT ≥ 23.0, `--enable-nodejs --mixed-context`) embeds `BridgeServer`; `AeBuildHost` writes
  the job to a temp file (U+2028/2029 escaped) and passes only the path through `evalScript`; reloads the jsx if the
  engine lost `F2AE`; 170 s eval timeout. Builtins emitted without `node:` prefix (CEP 11 = Node 15.9). Offline bundle
  import goes through `BridgeServer.buildLocal` (same validation + serial queue). 7 tests incl. **full-chain E2E**:
  extractor → ws transport → bridge → AeBuildHost → evalScript → compiled jsx in mocked AE → verified layer stack.
- **M6** `make build` (0.8 s), `make package` (zips + SHA256SUMS), `install.sh` (copy, quarantine clear,
  PlayerDebugMode CSXS 9–13, `--uninstall`) — installer verified in a sandboxed HOME with stubbed `defaults`.
  `check-sources.mjs` guards raw U+2028/2029 and version drift across 8 locations (+ `--tag` for releases).
- **M7** GitHub Actions on `macos-14` (arm64): CI (checks, typecheck, tests + JUnit, bench smoke, build, package,
  artifacts) and Release on `v*.*.*` tags (tag/version check → publish zips + checksums via action-gh-release).
- Totals: **114 tests**, 10 files, all passing; strict typecheck clean in all workspaces.

### Real After Effects validation (AE 26.5, 2026-10-28)
Driven via `osascript … DoScript` (results written to /tmp; DoScript return values don't propagate).
- **Bug 1 (user-reported "ExtendScript raised an error")**: ExtendScript's parser rejects unparenthesised nested
  ternaries (`a ? b ? c : d : e` → "Expected: :"), valid ES3 that acorn accepts. The jsx failed to load, so `F2AE`
  was never defined. Fix: build pass `parenthesizeNestedTernaries` (acorn AST) + gate check + tests.
- **Bug 2**: `TextDocument.tracking` must be an integer in AE → rounded. Failed nodes now roll back any partially
  created layers (previously left orphaned text layers).
- Confirmed in real AE: parenting, mask track mattes, Tritone gradients + luma alpha matte, `boxTextPos` = (−w/2,−h/2)
  for script-created box text, Drop Shadow opacity range 0–255, `app.fonts` PostScript lookup (Inter-Bold).
- Confirmed: reading `ADBE Vector Grad Colors` aborts the script engine → gradient colours are not scriptable
  (Tritone approach required).
- Component-shaped self-test (auto-layout frame, mixed-radius path, gradient, image, mask, open vector, point + box
  text, inside stroke, drop shadow): 9 layers, 0 warnings, both Break Apart modes, ~55 ms.

### File export (Figma plugin)
Export picker: AE bundle (.f2ae.json), **PNG** (scale from Advanced ▸ Image scale, clamped 0.5–4×), **SVG**
(outlined text, ids), **PDF** — via Figma's native `exportAsync`. One layer → direct download; several → STORE
zip (in-house writer, CRC-32, UTF-8 names; verified with system `unzip -t`).
