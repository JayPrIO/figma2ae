# Figma2AE

Send Figma selections to Adobe After Effects as **native, editable layers**: shape layers with
parametric rectangles and ellipses, bezier paths, live text, images, masks and precomps. Anchor
points, stacking order and parenting all come across correctly.

The layer mapping follows [AEUX](https://aeux.io). The connection is live and persistent, which is
the approach tools like Overlord take: the Figma plugin streams the design over a local WebSocket
to a panel running **inside After Effects**. No extra app needs to run, and nothing leaves your
machine.

```
Figma plugin ──(ws://localhost:7741)──▶ AE panel (CEP + Node) ──▶ ExtendScript builder ──▶ layers
```

| | |
|---|---|
| Platforms | macOS (Apple Silicon and Intel), Figma desktop or browser |
| After Effects | 2023 (23.0) or newer; per-character text styling needs 24.3+ |
| Install | GitHub Releases zips, manual install (below) |

## Install (users)

1. Download both zips from the [latest release](../../releases/latest).
2. **After Effects:** unzip `Figma2AE-ae-extension-*.zip` and run `sh install.sh` in Terminal.
   Restart AE, then open **Window ▸ Extensions ▸ Figma2AE**. Keep the panel open (docked is fine).
3. **Figma:** unzip `Figma2AE-figma-plugin-*.zip` somewhere permanent. In the Figma desktop app
   choose **Plugins ▸ Development ▸ Import plugin from manifest…** and pick `figma-plugin/manifest.json`.
4. Select frames or layers in Figma, open **Figma2AE** and press **Sync Selection**.

To uninstall the panel, run `sh install.sh --uninstall`.

## Features

| Figma | After Effects |
|---|---|
| Frame / Component / Instance | Comp (when it is a root), otherwise a background shape layer or Null used as parent |
| Clipping frame | Nested precomp (default) or alpha track matte |
| Group | Null used as parent |
| Rectangle (uniform radius) / Ellipse | Parametric Rect / Ellipse path |
| Vector, Boolean, Star, Polygon, Line, mixed radii | Bezier `Shape` paths (open paths stay open; even-odd winding kept) |
| Solid fills / strokes | Fill / Stroke (caps, joins, miter limit, dashes) |
| Inside / outside strokes | Offset parametric geometry, or outlined stroke geometry |
| Linear / radial gradients | Gradient Fill ramp recoloured by Tritone, plus a luma matte when alpha varies |
| Image fills (Fill / Fit / Crop) | Footage layer, exactly placed and masked to the node shape |
| Text | Point text or paragraph text with font, size, tracking, leading, alignment, case and per-range styles |
| Masks (alpha / vector / luminance) | Track mattes |
| Drop shadow / layer blur / inner shadow | Drop Shadow / Gaussian Blur / Inner Shadow layer style |
| Opacity, blend modes, hidden layers | Layer opacity, blending mode, disabled layers |
| Anything else (stickies, tiled images, video…) | Rasterised PNG at the chosen scale |

**Break Apart Layers**
- **On:** every node becomes its own AE layer, parented in the Figma hierarchy.
- **Off:** each selection becomes one shape layer whose groups mirror the hierarchy. Only nodes that
  need layer-level features (text, images, gradients, effects, masks) are split out, and they keep
  their stacking order.

**Offline fallback:** if AE isn't running, use **Export** in the Figma plugin and then
**Import bundle…** in the AE panel.

## Development

Requires Node 20+.

```sh
make install       # npm ci
make check         # typecheck + 100+ tests + source checks
make build         # → dist/ (prints local install steps)
make install-ae    # build + install the panel into your CEP folder
make dev-bridge    # bridge without AE: synced docs are saved to ./received
make bench         # micro-benchmarks
make package       # → dist/release/*.zip + SHA256SUMS.txt
```

| Path | What |
|---|---|
| `shared/` | Document schema, wire protocol, matrix and path math. The math is ES5-safe because it is compiled into the AE builder. |
| `figma-plugin/` | Main-thread extractor (`src/main`) and Preact UI with the resilient WebSocket client (`src/ui`). |
| `bridge-server/` | WebSocket relay: protocol, content-addressed asset cache, serial build queue, Prometheus metrics, structured logs. |
| `ae-extension/` | CEP panel that embeds the bridge (`src/panel`) and the ExtendScript builder (`src/jsx`, compiled TS → **ES3**). |
| `scripts/` | Build, package, install and source-check scripts. |

See [PLAN.md](PLAN.md) for the architecture, protocol, design decisions and milestone notes.

### How the ES3 builder is verified

`src/jsx` is TypeScript compiled through esbuild and Babel, then put through an ES3 gate. The gate
fails the build if any of these appear:
- syntax that acorn rejects with `ecmaVersion: 3`
- reserved words used as property names
- ES5+ runtime APIs
- non-ASCII characters

Tests run the **compiled** `.jsx` in a Node VM against a mocked AE DOM. They then rebuild every
layer's matrix from its anchor, position, scale, rotation and parent chain, and check that it lands
exactly on Figma's coordinates. The mock cannot prove fidelity inside real AE, so see the manual QA
checklist in PLAN.md §7.

### Debugging

- **Panel logs:** `~/Library/Logs/Figma2AE/bridge.log` (JSON lines).
- **Health and metrics:** `http://localhost:7741/health` and `/metrics` (Prometheus).
- **Panel DevTools:** run `make build-dev && make install-ae`, then open `http://localhost:8092`.
- **Verbose panel logging:** in the panel DevTools run `localStorage.setItem('f2ae.debug','1')`, then reload.

## Releasing

Bump the version in every `package.json`, in `shared/src/version.ts` and in
`ae-extension/cep/CSXS/manifest.xml`. `scripts/check-sources.mjs` enforces that they match. Then
run `git tag vX.Y.Z && git push --tags`. The release workflow tests, builds, zips and publishes
the GitHub Release with SHA-256 checksums.

## Security

- The bridge binds to loopback only (127.0.0.1 and ::1).
- WebSocket upgrades are accepted only from the Figma plugin origin (`null`, `figma.com`) or from
  non-browser local tools.
- Asset ids are strict hex. They are SHA-1 verified before anything touches disk, and they are
  used as content-addressed filenames.
- Document content is never evaluated as code.
