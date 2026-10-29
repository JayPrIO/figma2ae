import { describe, expect, it } from 'vitest';
import { DEFAULT_BUILD_OPTIONS, type ContainerNode, type ShapeNode, type TextNode } from '@f2ae/shared/schema';
import { validateDocument } from '@f2ae/shared/validate';
import { apply } from '@f2ae/shared/matrix';
import { extractSelection, mapLimit, rewriteAssetKeys, sniffMime } from '../src/main/extract';
import { gradientHandles, imagePlacement } from '../src/main/paints';
import { fakeApi, MIXED, node, rot, solid, text, tx } from './fake-figma';

const meta = { fileName: 'File', pageName: 'Page' };

describe('extractSelection', () => {
  it('re-bases nested auto-layout children onto the root bounding box', async () => {
    const child = node('RECTANGLE', { absoluteTransform: tx(130, 260), width: 20, height: 10, fills: [solid(1, 0, 0)] });
    const inner = node('FRAME', { absoluteTransform: tx(120, 240), width: 60, height: 40, children: [child] });
    const root = node('FRAME', { absoluteTransform: tx(100, 200), width: 300, height: 200, clipsContent: true, children: [inner] });

    const { document } = await extractSelection([root], DEFAULT_BUILD_OPTIONS, fakeApi(), meta);
    expect(validateDocument(document).ok).toBe(true);
    expect(document.roots[0].size).toEqual({ w: 300, h: 200 });
    expect(document.roots[0].canvasOrigin).toEqual([100, 200]);
    const r = document.roots[0].node as ContainerNode;
    expect(r.transform).toEqual([1, 0, 0, 1, 0, 0]);
    expect(r.clips).toBe(true);
    const c = (r.children[0] as ContainerNode).children[0] as ShapeNode;
    expect(c.transform.slice(4)).toEqual([30, 60]);
    expect(c.geometry).toEqual({ type: 'rect', w: 20, h: 10, radius: 0 });
    expect(c.fills[0]).toMatchObject({ type: 'solid', color: [1, 0, 0, 1] });
  });

  it('keeps rotation in the node transform', async () => {
    const r = node('RECTANGLE', { absoluteTransform: rot(30, 50, 50), width: 10, height: 10 });
    const { document } = await extractSelection([node('GROUP', { absoluteTransform: tx(0, 0), width: 100, height: 100, children: [r] })], DEFAULT_BUILD_OPTIONS, fakeApi(), meta);
    const s = (document.roots[0].node as ContainerNode).children[0];
    expect(s.transform[0]).toBeCloseTo(Math.cos(Math.PI / 6), 5);
    expect(s.transform[1]).toBeCloseTo(Math.sin(Math.PI / 6), 5);
  });

  it('chooses parametric vs path geometry correctly', async () => {
    const api = fakeApi();
    const shapes = [
      node('RECTANGLE', { cornerRadius: 8 }),
      node('RECTANGLE', { cornerRadius: MIXED, fillGeometry: [{ windingRule: 'NONZERO', data: 'M0 0L100 0L100 50Z' }] }),
      node('ELLIPSE', { arcData: { startingAngle: 0, endingAngle: 2 * Math.PI, innerRadius: 0 } }),
      node('ELLIPSE', { arcData: { startingAngle: 0, endingAngle: Math.PI, innerRadius: 0 }, fillGeometry: [{ windingRule: 'NONZERO', data: 'M0 0L1 1Z' }] }),
      node('VECTOR', { vectorPaths: [{ windingRule: 'EVENODD', data: 'M0 0 C 10 0 10 10 0 10' }] }),
      node('LINE', { width: 80, height: 0 }),
      node('POLYGON', { pointCount: 6 }),
      node('STAR', { pointCount: 5, innerRadius: 0.4 }),
    ];
    const g = node('GROUP', { children: shapes });
    const { document } = await extractSelection([g], DEFAULT_BUILD_OPTIONS, api, meta);
    const geos = (document.roots[0].node as ContainerNode).children.map((c) => (c as ShapeNode).geometry);
    expect(geos[0]).toEqual({ type: 'rect', w: 100, h: 50, radius: 8 });
    expect(geos[1].type).toBe('path');
    expect(geos[2]).toEqual({ type: 'ellipse', w: 100, h: 50 });
    expect(geos[3].type).toBe('path');
    expect(geos[4]).toMatchObject({ type: 'path', rule: 'evenodd' });
    expect(geos[4].type === 'path' && geos[4].paths[0].c).toBe(false);
    expect(geos[5].type === 'path' && geos[5].paths[0].v).toEqual([
      [0, 0],
      [80, 0],
    ]);
    expect(geos[6].type === 'path' && geos[6].paths[0].v.length).toBe(6);
    expect(geos[7].type === 'path' && geos[7].paths[0].v.length).toBe(10);
  });

  it('skips hidden children unless includeHidden', async () => {
    const g = node('GROUP', { children: [node('RECTANGLE', { visible: false }), node('RECTANGLE')] });
    const a = await extractSelection([g], DEFAULT_BUILD_OPTIONS, fakeApi(), meta);
    expect((a.document.roots[0].node as ContainerNode).children).toHaveLength(1);
    const b = await extractSelection([g], { ...DEFAULT_BUILD_OPTIONS, includeHidden: true }, fakeApi(), meta);
    const kids = (b.document.roots[0].node as ContainerNode).children;
    expect(kids).toHaveLength(2);
    expect(kids[0].visible).toBe(false);
  });

  it('converts text with per-segment styles and collects fonts', async () => {
    const t = text('Hello world', {
      segments: [
        { start: 0, end: 5, fontName: { family: 'Inter', style: 'Bold' }, fontSize: 20, fills: [solid(1, 0, 0)], letterSpacing: { unit: 'PERCENT', value: 10 }, lineHeight: { unit: 'AUTO' }, textDecoration: 'UNDERLINE', textCase: 'ORIGINAL' },
        { start: 5, end: 11, fontName: { family: 'Inter', style: 'Regular' }, fontSize: 20, fills: [solid(0, 0, 1)], letterSpacing: { unit: 'PIXELS', value: 1 }, lineHeight: { unit: 'PIXELS', value: 30 }, textDecoration: 'NONE', textCase: 'SMALL_CAPS_FORCED' },
      ],
    });
    const { document } = await extractSelection([t], DEFAULT_BUILD_OPTIONS, fakeApi(), meta);
    const n = document.roots[0].node as TextNode;
    expect(n.kind).toBe('text');
    expect(n.text.autoResize).toBe('widthAndHeight');
    expect(n.text.alignH).toBe('center');
    expect(n.text.segments[0]).toMatchObject({ letterSpacing: 2, lineHeight: null, decoration: 'underline', color: [1, 0, 0, 1] });
    expect(n.text.segments[1]).toMatchObject({ letterSpacing: 1, lineHeight: 30, textCase: 'smallCaps' });
    expect(document.fonts).toHaveLength(2);
  });

  it('collects image fills once, rasterises tiled images and unknown node types', async () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1]);
    const api = fakeApi({ abc: { bytes, w: 200, h: 100 } });
    const img = { type: 'IMAGE', scaleMode: 'FILL', imageHash: 'abc', visible: true, opacity: 1 };
    const a = node('RECTANGLE', { fills: [img] });
    const b = node('RECTANGLE', { fills: [img] });
    const tiled = node('RECTANGLE', { fills: [{ ...img, scaleMode: 'TILE' }] });
    const sticky = node('STICKY');
    const g = node('GROUP', { children: [a, b, tiled, sticky] });
    const { document, assets } = await extractSelection([g], DEFAULT_BUILD_OPTIONS, api, meta);
    expect(assets.filter((x) => x.key === 'img:abc')).toHaveLength(1);
    expect(assets.find((x) => x.key === 'img:abc')!.mime).toBe('image/jpeg');
    const kids = (document.roots[0].node as ContainerNode).children;
    expect(kids[2].kind).toBe('raster');
    expect(kids[3].kind).toBe('raster');
    expect(assets).toHaveLength(3);
    expect(document.warnings.some((w) => w.includes('rasterised'))).toBe(true);

    const map = new Map(assets.map((x, i) => [x.key, `${'0'.repeat(39)}${i}`]));
    rewriteAssetKeys(document, map);
    const shape = kids[0] as ShapeNode;
    expect(shape.fills[0].type === 'image' && shape.fills[0].asset).toBe(map.get('img:abc'));
    expect(kids[2].kind === 'raster' && kids[2].asset).toMatch(/^0+\d$/);
  });

  it('marks non-uniform strokes and non-center strokes on paths for outlining', async () => {
    const r = node('RECTANGLE', {
      strokes: [solid(0, 0, 0)],
      strokeWeight: MIXED,
      strokeTopWeight: 1,
      strokeRightWeight: 4,
      strokeBottomWeight: 1,
      strokeLeftWeight: 1,
      strokeGeometry: [{ windingRule: 'NONZERO', data: 'M0 0L1 0L1 1Z' }],
    });
    const v = node('VECTOR', {
      strokes: [solid(0, 0, 0)],
      strokeAlign: 'INSIDE',
      vectorPaths: [{ windingRule: 'NONZERO', data: 'M0 0L10 0L10 10Z' }],
      strokeGeometry: [{ windingRule: 'NONZERO', data: 'M0 0L1 0L1 1Z' }],
    });
    const e = node('ELLIPSE', { strokes: [solid(0, 0, 0)], strokeAlign: 'OUTSIDE', strokeWeight: 3 });
    const g = node('GROUP', { children: [r, v, e] });
    const { document } = await extractSelection([g], DEFAULT_BUILD_OPTIONS, fakeApi(), meta);
    const [sr, sv, se] = (document.roots[0].node as ContainerNode).children as ShapeNode[];
    expect(sr.stroke).toMatchObject({ uniform: false, weight: 4 });
    expect(sr.stroke!.outline).not.toBeNull();
    expect(sv.stroke!.outline).not.toBeNull();
    expect(se.stroke).toMatchObject({ align: 'outside', weight: 3, outline: null });
  });

  it('converts effects and masks', async () => {
    const m = node('RECTANGLE', { isMask: true, maskType: 'LUMINANCE' });
    const s = node('RECTANGLE', {
      effects: [
        { type: 'DROP_SHADOW', visible: true, color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 4 }, radius: 8, spread: 0, blendMode: 'NORMAL' },
        { type: 'LAYER_BLUR', visible: true, radius: 4 },
        { type: 'LAYER_BLUR', visible: false, radius: 4 },
      ],
    });
    const { document } = await extractSelection([node('GROUP', { children: [m, s] })], DEFAULT_BUILD_OPTIONS, fakeApi(), meta);
    const [mm, ss] = (document.roots[0].node as ContainerNode).children;
    expect(mm).toMatchObject({ isMask: true, maskType: 'luminance' });
    expect(ss.effects).toEqual([
      { type: 'dropShadow', color: [0, 0, 0, 0.5], offset: [0, 4], radius: 8, spread: 0, blendMode: 'normal' },
      { type: 'layerBlur', radius: 4 },
    ]);
  });

  it('reports progress on large trees', async () => {
    const children = Array.from({ length: 600 }, () => node('RECTANGLE'));
    const seen: number[] = [];
    await extractSelection([node('GROUP', { children })], DEFAULT_BUILD_OPTIONS, fakeApi(), meta, (n) => seen.push(n));
    expect(seen).toEqual([250, 500]);
  });
});

describe('paint math', () => {
  it('computes linear gradient handles from the identity gradient transform', () => {
    const h = gradientHandles(
      [
        [1, 0, 0],
        [0, 1, 0],
      ],
      { w: 200, h: 100 },
      false,
    );
    expect(h.start).toEqual([0, 50]);
    expect(h.end).toEqual([200, 50]);
  });

  it('flags elliptical radial gradients', () => {
    const h = gradientHandles(
      [
        [1, 0, 0],
        [0, 1, 0],
      ],
      { w: 200, h: 100 },
      true,
    );
    expect(h.start).toEqual([100, 50]);
    expect(h.elliptical).toBe(true);
  });

  it('places FILL images to cover and FIT images to contain, centred', () => {
    const fill = imagePlacement({ type: 'IMAGE', scaleMode: 'FILL' }, { w: 100, h: 100 }, { w: 200, h: 100 })!;
    expect(apply(fill, [0, 0])).toEqual([0, -50]);
    expect(apply(fill, [100, 100])).toEqual([200, 150]);
    const fit = imagePlacement({ type: 'IMAGE', scaleMode: 'FIT' }, { w: 100, h: 100 }, { w: 200, h: 100 })!;
    expect(apply(fit, [0, 0])).toEqual([50, 0]);
    expect(imagePlacement({ type: 'IMAGE', scaleMode: 'TILE' }, { w: 1, h: 1 }, { w: 1, h: 1 })).toBeNull();
  });

  it('handles rotated FILL images and CROP transforms', () => {
    const r = imagePlacement({ type: 'IMAGE', scaleMode: 'FILL', rotation: 90 }, { w: 100, h: 50 }, { w: 50, h: 100 })!;
    const p = apply(r, [0, 0]);
    expect(p[0]).toBeCloseTo(50);
    expect(p[1]).toBeCloseTo(0);
    // crop showing the right half of the image across the node
    const c = imagePlacement(
      {
        type: 'IMAGE',
        scaleMode: 'CROP',
        imageTransform: [
          [0.5, 0, 0.5],
          [0, 1, 0],
        ],
      },
      { w: 100, h: 100 },
      { w: 100, h: 100 },
    )!;
    expect(apply(c, [50, 0])).toEqual([0, 0]);
    expect(apply(c, [100, 100])).toEqual([100, 100]);
  });
});

describe('utilities', () => {
  it('sniffs mime types', () => {
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0, 0]))).toBe('image/jpeg');
    expect(sniffMime(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe('image/gif');
    expect(sniffMime(new Uint8Array([137, 80, 78, 71]))).toBe('image/png');
  });

  it('mapLimit respects the concurrency cap and preserves order', async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });
});
