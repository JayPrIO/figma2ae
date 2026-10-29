/**
 * Runs the COMPILED ES3 f2ae.jsx inside a Node VM against a mocked AE DOM.
 * The key invariant ("re-projection"): for every layer we rebuild layer→comp from the AE
 * transform values + parent chain and check node-local points land where Figma put them.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { apply, multiply, rotationDeg, scaling, shearing, translation } from '@f2ae/shared/matrix';
import type { F2AEDocument, Mat2x3, Pt } from '@f2ae/shared/schema';
// @ts-expect-error — plain ESM build script
import { buildJsx, parenthesizeNestedTernaries, verifyEs3 } from '../build-jsx.mjs';
import { createAe, type MockComp, type MockLayer, type MockProp } from './ae-mock';
import { at, doc, frame, group, raster, rect, solid, stroke, text } from './fixtures';

let code = '';
let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'f2ae-jsx-'));
  const r = await buildJsx({ outfile: join(dir, 'f2ae.jsx') });
  code = r.code;
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let jobSeq = 0;
async function run(d: F2AEDocument, assetPaths: Record<string, string> = {}, opts = {}) {
  const ae = createAe(code, opts);
  const job = join(dir, `job${++jobSeq}.json`);
  await writeFile(job, JSON.stringify({ document: d, assetPaths }));
  const result = JSON.parse(ae.F2AE.buildFromFile(job));
  return { ae, result };
}

/** layer space → comp space, rebuilt from AE transform values and parent chain. */
function layerToComp(l: MockLayer): Mat2x3 {
  const a = l.transformValue('ADBE Anchor Point') as Pt;
  const p = l.transformValue('ADBE Position') as Pt;
  const s = l.transformValue('ADBE Scale') as Pt;
  const r = l.transformValue('ADBE Rotate Z') as number;
  const local = multiply(translation(p[0], p[1]), multiply(rotationDeg(r), multiply(scaling(s[0] / 100, s[1] / 100), translation(-a[0], -a[1]))));
  return l.parent ? multiply(layerToComp(l.parent), local) : local;
}

function expectPt(actual: Pt, expected: Pt, digits = 4): void {
  expect(actual[0]).toBeCloseTo(expected[0], digits);
  expect(actual[1]).toBeCloseTo(expected[1], digits);
}

function byName(c: MockComp, name: string): MockLayer {
  const l = c.stack.find((x) => x.name === name);
  if (!l) throw new Error(`no layer "${name}" in [${c.stack.map((x) => x.name).join(', ')}]`);
  return l;
}

/** AE stack top→bottom names */
const names = (c: MockComp) => c.stack.map((l) => l.name);

describe('ES3 output', () => {
  it('passes the ES3 syntax + forbidden API gate', () => {
    expect(() => verifyEs3(code)).not.toThrow();
    expect(code.length).toBeGreaterThan(10_000);
  });

  it('rejects ES5+ syntax and APIs', () => {
    expect(() => verifyEs3('var a = [1].map(function (x) { return x; });')).toThrow(/forbidden/);
    expect(() => verifyEs3('let a = 1;')).toThrow(/ES3 gate/);
    expect(() => verifyEs3('var o = { get x() { return 1; } };')).toThrow(/ES3 gate/);
    expect(() => verifyEs3('var o = { default: 1 };')).toThrow(/ES3 gate/);
    expect(() => verifyEs3('var s = "é";')).toThrow(/ASCII/);
  });

  it('parenthesises nested ternaries (ExtendScript parser quirk) and the gate enforces it', () => {
    const src = 'var a = x ? y ? 1 : 2 : z ? 3 : 4;';
    expect(() => verifyEs3(src)).toThrow(/nested ternary/);
    const fixed = parenthesizeNestedTernaries(src);
    expect(fixed).toBe('var a = x ? (y ? 1 : 2) : (z ? 3 : 4);');
    expect(() => verifyEs3(fixed)).not.toThrow();
    expect(new Function(`${fixed}; return a;`.replace(/x|y|z/g, '1'))()).toBe(1);
    expect(parenthesizeNestedTernaries('var b = p ? q ? r ? 1 : 2 : 3 : 4;')).toBe('var b = p ? (q ? (r ? 1 : 2) : 3) : 4;');
  });

  it('ping reports versions without throwing', () => {
    const ae = createAe(code);
    expect(JSON.parse(ae.F2AE.ping())).toMatchObject({ ok: true, version: '1.0.0', ae: '25.0x12' });
  });

  it('returns a structured failure for a missing job file', () => {
    const ae = createAe(code);
    const r = JSON.parse(ae.F2AE.buildFromFile('/nope/missing.json'));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/file not found/);
  });
});

describe('break apart', () => {
  it('creates a comp per root, parents children, and places every layer exactly (re-projection)', async () => {
    const r1 = rect('Rotated', 40, 20, at(100, 50, 30));
    const r2 = rect('Inner', 10, 10, at(150, 120));
    const g = group('Group', 60, 60, at(140, 110), [r2]);
    const f = frame('Card', 300, 200, at(0, 0), [r1, g]);
    const { ae, result } = await run(doc([{ node: f, w: 300, h: 200 }]));
    expect(result.ok).toBe(true);
    expect(result.stats).toMatchObject({ comps: 1, layers: 4 });
    const [comp] = ae.comps();
    expect(comp).toMatchObject({ name: 'Card', width: 300, height: 200, frameRate: 30, duration: 10 });
    expect(comp.openedInViewer).toBe(true);

    // bottom→top Figma order == AE stack reversed
    expect(names(comp)).toEqual(['Inner', 'Group', 'Rotated', 'Card']);
    const card = byName(comp, 'Card');
    expect(byName(comp, 'Rotated').parent).toBe(card);
    expect(byName(comp, 'Group').parent).toBe(card);
    expect(byName(comp, 'Group').kind).toBe('null');
    expect(byName(comp, 'Inner').parent).toBe(byName(comp, 'Group'));

    for (const [name, node] of [
      ['Rotated', r1],
      ['Inner', r2],
      ['Card', f],
    ] as const) {
      const M = layerToComp(byName(comp, name));
      for (const p of [
        [0, 0],
        [node.size.w, 0],
        [node.size.w, node.size.h],
      ] as Pt[]) {
        expectPt(apply(M, p), apply(node.transform, p));
      }
    }
    // anchor at the node centre
    expect(byName(comp, 'Rotated').transformValue('ADBE Anchor Point')).toEqual([20, 10]);
    expect(byName(comp, 'Rotated').transformValue('ADBE Rotate Z')).toBeCloseTo(30);
    expect(ae.app.undoGroups).toEqual([expect.stringContaining('begin:Figma2AE'), 'end']);
  });

  it('bakes residual shear into path vertices so geometry stays exact', async () => {
    const T: Mat2x3 = multiply(at(50, 50, 15), multiply(scaling(2, 1), shearing(0.5)));
    const r = rect('Skewed', 20, 10, T);
    const { ae } = await run(doc([{ node: group('G', 100, 100, at(0, 0), [r]), w: 100, h: 100 }]));
    const layer = byName(ae.comps()[0], 'Skewed');
    const pathProp = layer.all('ADBE Vector Shape')[0];
    const shape = pathProp.value;
    const M = layerToComp(layer);
    // vertex 2 of rectToPath(20,10) is (20,10) in node space
    expectPt(apply(M, shape.vertices[2] as Pt), apply(T, [20, 10]));
  });

  it('maps parametric rect/ellipse, fills in reverse order, strokes above fills', async () => {
    const r = rect('R', 40, 20, at(0, 0), { geometry: { type: 'rect', w: 40, h: 20, radius: 6 }, fills: [solid(1, 0, 0), solid(0, 1, 0, 0.5)], stroke: stroke() });
    const e = rect('E', 30, 30, at(50, 0), { geometry: { type: 'ellipse', w: 30, h: 30 } });
    const { ae } = await run(doc([{ node: group('G', 100, 40, at(0, 0), [r, e]), w: 100, h: 40 }]));
    const comp = ae.comps()[0];
    const contents = byName(comp, 'R').property('ADBE Root Vectors Group').children[0].property('ADBE Vectors Group');
    expect(contents.children.map((c: MockProp) => c.matchName)).toEqual([
      'ADBE Vector Shape - Rect',
      'ADBE Vector Graphic - Stroke',
      'ADBE Vector Graphic - Fill',
      'ADBE Vector Graphic - Fill',
    ]);
    expect(contents.children[0].property('ADBE Vector Rect Roundness').value).toBe(6);
    expect(contents.children[0].property('ADBE Vector Rect Position').value).toEqual([20, 10]);
    // top-most Figma fill (green, 50%) first
    expect(contents.children[2].property('ADBE Vector Fill Color').value).toEqual([0, 1, 0]);
    expect(contents.children[2].property('ADBE Vector Fill Opacity').value).toBe(50);
    expect(byName(comp, 'E').all('ADBE Vector Shape - Ellipse')).toHaveLength(1);
  });

  it('offsets parametric geometry for inside/outside strokes and outlines non-uniform strokes', async () => {
    const inside = rect('In', 40, 20, at(0, 0), { stroke: stroke({ align: 'inside', weight: 4 }) });
    const outlined = rect('Out', 40, 20, at(0, 0), {
      stroke: stroke({ uniform: false, outline: { type: 'path', rule: 'nonzero', paths: [{ c: true, v: [[0, 0], [1, 0], [1, 1]], i: [[0, 0], [0, 0], [0, 0]], o: [[0, 0], [0, 0], [0, 0]] }] } }),
    });
    const { ae } = await run(doc([{ node: group('G', 40, 20, at(0, 0), [inside, outlined]), w: 40, h: 20 }]));
    const comp = ae.comps()[0];
    const strokeGroup = byName(comp, 'In').all('ADBE Vector Group').find((g) => g.name === 'Stroke')!;
    expect(strokeGroup.all('ADBE Vector Rect Size')[0].value).toEqual([36, 16]);
    const outGroup = byName(comp, 'Out').all('ADBE Vector Group').find((g) => g.name === 'Stroke')!;
    expect(outGroup.all('ADBE Vector Graphic - Fill')).toHaveLength(1);
  });

  it('turns clipping frames into precomps by default and into alpha mattes when asked', async () => {
    const inner = () => frame('Clip', 100, 100, at(20, 20), [rect('Big', 300, 300, at(0, 0))], { clips: true });
    const a = await run(doc([{ node: group('Root', 200, 200, at(0, 0), [inner()]), w: 200, h: 200 }]));
    const comps = a.ae.comps();
    expect(comps.map((c) => c.name)).toEqual(['Root', 'Clip']);
    const pre = comps[1];
    expect(names(pre)).toEqual(['Big', 'Clip ▸ background']);
    // inside the precomp, Big's (0,0) sits at (-20,-20) relative to the frame
    expectPt(apply(layerToComp(byName(pre, 'Big')), [0, 0]), [-20, -20]);
    const preLayer = byName(comps[0], 'Clip');
    expect(preLayer.source).toBe(pre);
    expectPt(apply(layerToComp(preLayer), [0, 0]), [20, 20]);

    const b = await run(doc([{ node: group('Root', 200, 200, at(0, 0), [inner()]), w: 200, h: 200 }], { clippedFramesAsPrecomps: false }));
    const c = b.ae.comps()[0];
    expect(b.ae.comps()).toHaveLength(1);
    const matte = byName(c, 'Clip ▸ clip');
    expect(matte.enabled).toBe(false);
    expect(byName(c, 'Big').trackMatteLayer).toBe(matte);
    expect(byName(c, 'Big').trackMatteType).toBe(1);
  });

  it('applies masks to the siblings above them, honouring mask type', async () => {
    const mask = rect('Mask', 50, 50, at(0, 0), { isMask: true, maskType: 'luminance' });
    const a = rect('A', 10, 10, at(0, 0));
    const b = rect('B', 10, 10, at(5, 5));
    const below = rect('Below', 10, 10, at(0, 0));
    const { ae } = await run(doc([{ node: group('G', 50, 50, at(0, 0), [below, mask, a, b]), w: 50, h: 50 }]));
    const c = ae.comps()[0];
    const m = byName(c, 'Mask');
    expect(m.enabled).toBe(false);
    expect(byName(c, 'A').trackMatteLayer).toBe(m);
    expect(byName(c, 'B').trackMatteType).toBe(3); // LUMA
    expect(byName(c, 'Below').trackMatteLayer).toBeNull();
  });

  it('warns instead of matting on AE < 23', async () => {
    const mask = rect('Mask', 50, 50, at(0, 0), { isMask: true });
    const { ae, result } = await run(doc([{ node: group('G', 50, 50, at(0, 0), [mask, rect('A', 10, 10, at(0, 0))]), w: 50, h: 50 }]), {}, { version: '22.6x1' });
    expect(byName(ae.comps()[0], 'A').trackMatteLayer).toBeNull();
    expect(result.warnings.join('\n')).toMatch(/2023/);
  });

  it('builds gradients as ramp + Tritone, with a luma matte for varying alpha', async () => {
    const g = rect('Grad', 100, 50, at(0, 0), {
      fills: [
        {
          type: 'linear',
          start: [0, 25],
          end: [100, 25],
          stops: [
            { pos: 0, color: [1, 0, 0, 1] },
            { pos: 1, color: [0, 0, 1, 0] },
          ],
          opacity: 1,
          blendMode: 'normal',
          approximated: false,
        },
      ],
      stroke: stroke(),
    });
    const { ae } = await run(doc([{ node: group('G', 100, 50, at(0, 0), [g]), w: 100, h: 50 }]));
    const c = ae.comps()[0];
    expect(names(c)).toEqual(['Grad ▸ paint', 'Grad ▸ gradient alpha', 'Grad', 'G']);
    const gradLayer = byName(c, 'Grad');
    const tri = gradLayer.property('ADBE Effect Parade').children[0];
    expect(tri.matchName).toBe('ADBE Tritone');
    expect(tri.property('ADBE Tritone-0001').value).toEqual([1, 0, 0]);
    expect(tri.property('ADBE Tritone-0003').value).toEqual([0, 0, 1]);
    expect(gradLayer.all('ADBE Vector Grad End Pt')[0].value).toEqual([100, 25]);
    const alpha = byName(c, 'Grad ▸ gradient alpha');
    expect(gradLayer.trackMatteLayer).toBe(alpha);
    expect(gradLayer.trackMatteType).toBe(3);
    expect(alpha.property('ADBE Effect Parade').children[0].property('ADBE Tritone-0002').value).toEqual([0.5, 0.5, 0.5]);
    // stroke pass is parented to the primary and lands on the same geometry
    const paint = byName(c, 'Grad ▸ paint');
    expect(paint.parent).toBe(gradLayer);
    expectPt(apply(layerToComp(paint), [100, 50]), [100, 50]);
  });

  it('imports each image once, places it with the paint placement and masks it to the node', async () => {
    const imgPath = join(dir, 'img-200x100.png');
    await writeFile(imgPath, 'x');
    const paint = { type: 'image' as const, asset: 'aaaaaaaa', imageSize: { w: 200, h: 100 }, placement: [0.5, 0, 0, 0.5, 0, 0] as Mat2x3, opacity: 1, blendMode: 'normal' as const, scaleMode: 'fill' as const };
    const a = rect('A', 100, 50, at(10, 10), { fills: [paint] });
    const b = rect('B', 100, 50, at(10, 80), { fills: [paint] });
    const { ae } = await run(doc([{ node: group('G', 200, 200, at(0, 0), [a, b]), w: 200, h: 200 }]), { aaaaaaaa: imgPath });
    expect(ae.footage()).toHaveLength(1);
    expect(ae.footage()[0].comment).toBe('f2ae:aaaaaaaa');
    const c = ae.comps()[0];
    const la = byName(c, 'A');
    expect(la.kind).toBe('av');
    expectPt(apply(layerToComp(la), [200, 100]), [110, 60]);
    const mask = la.property('ADBE Mask Parade').children[0].property('ADBE Mask Shape').value;
    // node corner (100,50) → image px (200,100)
    expectPt(mask.vertices[2] as Pt, [200, 100]);
  });

  it('places rasters and warns when assets are missing', async () => {
    const p = join(dir, 'ras-80x40.png');
    await writeFile(p, 'x');
    const ok = raster('R', 40, 20, at(5, 5), 'bbbbbbbb');
    const missing = raster('M', 40, 20, at(5, 5), 'cccccccc');
    const { ae, result } = await run(doc([{ node: group('G', 100, 100, at(0, 0), [ok, missing]), w: 100, h: 100 }]), { bbbbbbbb: p });
    const r = byName(ae.comps()[0], 'R');
    expectPt(apply(layerToComp(r), [80, 40]), [45, 25]);
    expect(result.warnings.join()).toMatch(/not transferred/);
  });

  it('builds text with font lookup, per-segment styles, case transform and box placement', async () => {
    const t = text('Title', 'hello\nworld', 120, 60, at(10, 20), {
      segments: [
        { start: 0, end: 5, font: { family: 'Inter', style: 'Bold' }, size: 20, lineHeight: 24, letterSpacing: 2, color: [1, 0, 0, 1], decoration: 'none', textCase: 'upper' },
        { start: 5, end: 11, font: { family: 'Inter', style: 'Regular' }, size: 16, lineHeight: null, letterSpacing: 0, color: [0, 0, 1, 1], decoration: 'underline', textCase: 'original' },
      ],
    });
    const { ae, result } = await run(doc([{ node: group('G', 200, 100, at(0, 0), [t]), w: 200, h: 100 }]));
    expect(result.ok).toBe(true);
    const l = byName(ae.comps()[0], 'Title');
    const td = l.property('ADBE Text Properties').property('ADBE Text Document').value;
    expect(td.text).toBe('HELLO\rworld');
    expect(td.font).toBe('Inter-Bold');
    expect(td.tracking).toBe(100);
    expect(td.ranges).toHaveLength(2);
    expect(td.ranges[1].style).toMatchObject({ font: 'Inter-Regular', fontSize: 16, autoLeading: true, underline: true });
    // box text: node-local (0,0) → comp (10,20)
    const M = layerToComp(l);
    const bp = td.boxTextPos as Pt;
    expectPt(apply(M, [bp[0] + 1, bp[1]]), [10, 20]);
  });

  it('falls back to the dominant style without characterRange and reports font substitution', async () => {
    const t = text('T', 'ab', 50, 20, at(0, 0), {
      autoResize: 'widthAndHeight',
      segments: [
        { start: 0, end: 1, font: { family: 'Inter', style: 'Bold' }, size: 20, lineHeight: null, letterSpacing: 0, color: [0, 0, 0, 1], decoration: 'none', textCase: 'original' },
        { start: 1, end: 2, font: { family: 'Comic Neue', style: 'Regular' }, size: 20, lineHeight: null, letterSpacing: 0, color: [0, 0, 0, 1], decoration: 'none', textCase: 'original' },
      ],
    });
    const { result } = await run(doc([{ node: t, w: 50, h: 20 }]), {}, { characterRange: false, installedFonts: ['Inter-Bold'] });
    expect(result.warnings.join('\n')).toMatch(/24\.3/);
  });

  it('propagates group opacity to children (AE parenting does not) and disables hidden nodes', async () => {
    const child = rect('C', 10, 10, at(0, 0), { opacity: 0.5 });
    const hidden = rect('H', 10, 10, at(0, 0), { visible: false });
    const g = { ...group('G', 10, 10, at(0, 0), [child, hidden]), opacity: 0.5 };
    const { ae } = await run(doc([{ node: g, w: 10, h: 10 }]));
    const c = ae.comps()[0];
    expect(byName(c, 'C').transformValue('ADBE Opacity')).toBeCloseTo(25);
    expect(byName(c, 'H').enabled).toBe(false);
  });

  it('applies drop shadow and blur effects', async () => {
    const r = rect('Shadowed', 10, 10, at(0, 0), {
      effects: [
        { type: 'dropShadow', color: [0, 0, 0, 0.5], offset: [0, 4], radius: 8, spread: 2, blendMode: 'normal' },
        { type: 'layerBlur', radius: 3 },
      ],
    });
    const { ae, result } = await run(doc([{ node: r, w: 10, h: 10 }]));
    const fx = byName(ae.comps()[0], 'Shadowed').property('ADBE Effect Parade').children;
    expect(fx.map((f: MockProp) => f.matchName)).toEqual(['ADBE Drop Shadow', 'ADBE Gaussian Blur 2']);
    expect(fx[0].property('ADBE Drop Shadow-0003').value).toBeCloseTo(180);
    expect(fx[0].property('ADBE Drop Shadow-0004').value).toBe(4);
    expect(fx[0].property('ADBE Drop Shadow-0002').value).toBeCloseTo(127.5);
    expect(result.warnings.join()).toMatch(/spread/);
  });

  it('adds into the active comp, preserving relative layout and centring the union', async () => {
    const d = doc(
      [
        { node: rect('A', 100, 100, at(0, 0)), w: 100, h: 100, origin: [1000, 1000] },
        { node: rect('B', 100, 100, at(0, 0)), w: 100, h: 100, origin: [1200, 1000] },
      ],
      { target: 'activeComp' },
    );
    const ae = createAe(code);
    const active = ae.project.items.addComp('Existing', 1920, 1080, 1, 10, 30);
    ae.project.activeItem = active;
    const job = join(dir, 'active.json');
    await writeFile(job, JSON.stringify({ document: d, assetPaths: {} }));
    const res = JSON.parse(ae.F2AE.buildFromFile(job));
    expect(res.stats.comps).toBe(0);
    expect(active.stack).toHaveLength(2);
    // union 300x100 centred in 1920x1080 → A's top-left at (810, 490)
    expectPt(apply(layerToComp(byName(active, 'A')), [0, 0]), [810, 490]);
    expectPt(apply(layerToComp(byName(active, 'B')), [0, 0]), [1010, 490]);
  });

  it('rounds tracking to an integer (AE rejects fractional tracking)', async () => {
    const t = text('T', 'abc', 50, 20, at(0, 0));
    t.text.segments[0].letterSpacing = 0.37; // 0.37 / 20 * 1000 = 18.5
    const { ae, result } = await run(doc([{ node: t, w: 50, h: 20 }]));
    expect(result.warnings).toEqual([]);
    expect(byName(ae.comps()[0], 'T').property('ADBE Text Properties').property('ADBE Text Document').value.tracking).toBe(19);
  });

  it('rolls back partially created layers when a node fails', async () => {
    const t = text('Broken', 'x', 10, 10, at(0, 0));
    (t.text.segments[0] as { font: unknown }).font = null; // throws after the text layer exists
    const { ae, result } = await run(doc([{ node: group('G', 10, 10, at(0, 0), [t, rect('Ok', 5, 5, at(0, 0))]), w: 10, h: 10 }]));
    expect(result.warnings.join()).toMatch(/"Broken": failed to build/);
    expect(names(ae.comps()[0])).toEqual(['Ok', 'G']);
    expect(result.stats.layers).toBe(2);
  });

  it('survives a node that throws and reports it as a warning', async () => {
    const bad = rect('Bad', 10, 10, at(0, 0));
    (bad as unknown as { geometry: unknown }).geometry = { type: 'path', rule: 'nonzero', paths: null };
    const { ae, result } = await run(doc([{ node: group('G', 10, 10, at(0, 0), [bad, rect('Good', 10, 10, at(0, 0))]), w: 10, h: 10 }]));
    expect(result.ok).toBe(true);
    expect(result.warnings.join()).toMatch(/"Bad": failed to build/);
    expect(names(ae.comps()[0])).toContain('Good');
  });
});

describe('keep as group (Break Apart off)', () => {
  it('collapses a pure-vector tree into ONE shape layer with nested, correctly placed groups', async () => {
    const r1 = rect('A', 10, 10, at(10, 10));
    const r2 = rect('B', 10, 10, at(60, 60, 45));
    const inner = group('Inner', 40, 40, at(50, 50), [r2]);
    const root = frame('Root', 200, 100, at(0, 0), [r1, inner]);
    const { ae, result } = await run(doc([{ node: root, w: 200, h: 100 }], { breakApart: false }));
    expect(result.stats.layers).toBe(1);
    const c = ae.comps()[0];
    expect(names(c)).toEqual(['Root']);
    const rootContents = c.stack[0].property('ADBE Root Vectors Group');
    // top-first: Inner group, A, Background
    expect(rootContents.children.map((g: MockProp) => g.name)).toEqual(['Inner', 'A', 'Background']);
    const innerG = rootContents.children[0];
    const bG = innerG.property('ADBE Vectors Group').children[0];
    expect(bG.name).toBe('B');

    // re-project B through layer + group transforms
    const groupMat = (g: MockProp): Mat2x3 => {
      const t = g.property('ADBE Vector Transform Group');
      const a = t.property('ADBE Vector Anchor').value as Pt;
      const p = t.property('ADBE Vector Position').value as Pt;
      const s = t.property('ADBE Vector Scale').value as Pt;
      const r = t.property('ADBE Vector Rotation').value as number;
      return multiply(translation(p[0], p[1]), multiply(rotationDeg(r), multiply(scaling(s[0] / 100, s[1] / 100), translation(-a[0], -a[1]))));
    };
    const M = multiply(layerToComp(c.stack[0]), multiply(groupMat(innerG), groupMat(bG)));
    expectPt(apply(M, [10, 10]), apply(r2.transform, [10, 10]));
  });

  it('splits out special nodes and keeps stacking order with chunked shape layers', async () => {
    const below = rect('Below', 10, 10, at(0, 0));
    const t = text('Label', 'hi', 20, 10, at(0, 0));
    const above = rect('Above', 10, 10, at(0, 0));
    const root = group('Root', 100, 100, at(0, 0), [below, t, above]);
    const { ae } = await run(doc([{ node: root, w: 100, h: 100 }], { breakApart: false }));
    const c = ae.comps()[0];
    expect(names(c)).toEqual(['Root ▸ shapes 2', 'Label', 'Root ▸ shapes', 'Root']);
    const nul = byName(c, 'Root');
    expect(nul.kind).toBe('null');
    for (const n of ['Root ▸ shapes 2', 'Label', 'Root ▸ shapes']) expect(byName(c, n).parent).toBe(nul);
    expectPt(apply(layerToComp(byName(c, 'Label')), [td0(byName(c, 'Label'))[0] + 1, td0(byName(c, 'Label'))[1]]), [0, 0]);
  });

  it('keeps clipped frames grouped inside their precomp', async () => {
    const clip = frame('Clip', 50, 50, at(10, 10), [rect('X', 100, 100, at(0, 0)), rect('Y', 5, 5, at(20, 20))], { clips: true });
    const root = group('Root', 100, 100, at(0, 0), [clip]);
    const { ae } = await run(doc([{ node: root, w: 100, h: 100 }], { breakApart: false }));
    const [main, pre] = ae.comps();
    expect(pre.name).toBe('Clip');
    expect(names(pre)).toEqual(['Clip ▸ contents', 'Clip ▸ background']);
    expect(byName(main, 'Clip').source).toBe(pre);
  });
});

function td0(l: MockLayer): Pt {
  return l.property('ADBE Text Properties').property('ADBE Text Document').value.boxTextPos as Pt;
}
