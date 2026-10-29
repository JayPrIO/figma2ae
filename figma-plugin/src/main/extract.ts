/**
 * Selection → F2AEDocument extractor (runs on Figma's main thread).
 *
 *  - Depth-first traversal preserving Figma child order (bottom → top).
 *  - Coordinates: every node's absoluteTransform (which already resolves nested Auto Layout,
 *    constraints and rotation) is re-based onto its root's axis-aligned bounding box.
 *  - Geometry: parametric rect/ellipse when exactly representable, otherwise bezier paths
 *    (vectorPaths / fillGeometry / computed polygons & stars).
 *  - Images are collected by hash and fetched after traversal with bounded concurrency;
 *    anything without a faithful vector mapping is rasterised via exportAsync.
 *
 * Duck-typed against Figma node shapes so tests can drive it with plain objects.
 */
import { fromFigma, invert, multiply, translation } from '@f2ae/shared/matrix';
import type {
  BuildOptions,
  ContainerNode,
  F2AEDocument,
  FontRef,
  Geometry,
  Mat2x3,
  MaskType,
  PathGeometry,
  RasterNode,
  Root,
  SceneNode as F2Node,
  ShapeNode,
  Size,
  Stroke,
  StrokeCap,
  StrokeJoin,
} from '@f2ae/shared/schema';
import { parseSvgPath, roundPaths } from '@f2ae/shared/svg-path';
import { PRODUCT_NAME, PRODUCT_VERSION } from '@f2ae/shared/version';
import type { BezierPath, Pt } from '@f2ae/shared/schema';
import { convertEffects, convertPaints, mapBlendMode, type PaintContext } from './paints';
import { convertText, type TextSource } from './text';

/* eslint-disable @typescript-eslint/no-explicit-any */
type FNode = any;

export interface ImageHandle {
  getBytesAsync(): Promise<Uint8Array>;
  getSizeAsync(): Promise<{ width: number; height: number }>;
}

export interface ExtractApi {
  mixed: symbol;
  getImageByHash(hash: string): ImageHandle | null;
}

export interface ExtractedAsset {
  /** provisional key referenced from the document; the UI replaces it with a SHA-1 */
  key: string;
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg' | 'image/gif';
  width: number;
  height: number;
}

export interface ExtractResult {
  document: F2AEDocument;
  assets: ExtractedAsset[];
}

export interface ExtractMeta {
  fileName: string;
  pageName: string;
}

const CONTAINER_TYPES: Record<string, true> = {
  FRAME: true,
  GROUP: true,
  COMPONENT: true,
  COMPONENT_SET: true,
  INSTANCE: true,
  SECTION: true,
};
const SHAPE_TYPES: Record<string, true> = {
  RECTANGLE: true,
  ELLIPSE: true,
  VECTOR: true,
  LINE: true,
  STAR: true,
  POLYGON: true,
  BOOLEAN_OPERATION: true,
};
const SKIP_TYPES: Record<string, true> = { SLICE: true };

const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const roundMat = (m: Mat2x3): Mat2x3 => [
  Math.round(m[0] * 1e6) / 1e6,
  Math.round(m[1] * 1e6) / 1e6,
  Math.round(m[2] * 1e6) / 1e6,
  Math.round(m[3] * 1e6) / 1e6,
  r3(m[4]),
  r3(m[5]),
];

interface RasterRequest {
  key: string;
  node: FNode;
}

class Ctx {
  readonly warnings: string[] = [];
  private readonly warned = new Set<string>();
  readonly images = new Map<string, string>(); // figma hash → key
  readonly imageSizes = new Map<string, Promise<Size | null>>();
  readonly rasters: RasterRequest[] = [];
  readonly fonts = new Map<string, FontRef>();
  nodeCount = 0;

  constructor(
    readonly api: ExtractApi,
    readonly options: BuildOptions,
    readonly onProgress?: (n: number) => void,
  ) {}

  warn(msg: string): void {
    if (this.warned.has(msg) || this.warnings.length >= 200) return;
    this.warned.add(msg);
    this.warnings.push(msg);
  }

  requestImage(hash: string): string {
    let k = this.images.get(hash);
    if (!k) {
      k = `img:${hash}`;
      this.images.set(hash, k);
    }
    return k;
  }

  imageSize(hash: string): Promise<Size | null> {
    let p = this.imageSizes.get(hash);
    if (!p) {
      const img = this.api.getImageByHash(hash);
      p = img
        ? img.getSizeAsync().then(
            (s) => ({ w: s.width, h: s.height }),
            () => null,
          )
        : Promise.resolve(null);
      this.imageSizes.set(hash, p);
    }
    return p;
  }

  requestRaster(node: FNode): string {
    const key = `ras:${node.id}`;
    this.rasters.push({ key, node });
    return key;
  }
}

// ─────────────────────────────── geometry ───────────────────────────────

function vectorPathsToGeometry(vp: ReadonlyArray<{ windingRule: string; data: string }> | undefined, ctx: Ctx, name: string): PathGeometry | null {
  if (!vp || vp.length === 0) return null;
  const paths: BezierPath[] = [];
  let evenodd = false;
  for (const p of vp) {
    if (p.windingRule === 'EVENODD') evenodd = true;
    const r = parseSvgPath(p.data);
    if (r.error) ctx.warn(`"${name}": path data partially parsed (${r.error})`);
    for (const sp of r.paths) paths.push(sp);
  }
  if (paths.length === 0) return null;
  return { type: 'path', paths: roundPaths(paths), rule: evenodd ? 'evenodd' : 'nonzero' };
}

function regularPolygon(n: number, w: number, h: number, innerRatio: number | null): BezierPath {
  const count = innerRatio === null ? n : n * 2;
  const v: Pt[] = [];
  const zero = (): Pt => [0, 0];
  for (let k = 0; k < count; k++) {
    const a = -Math.PI / 2 + (k * 2 * Math.PI) / count;
    const rr = innerRatio !== null && k % 2 === 1 ? innerRatio : 1;
    v.push([r3(w / 2 + (w / 2) * rr * Math.cos(a)), r3(h / 2 + (h / 2) * rr * Math.sin(a))]);
  }
  return { c: true, v, i: v.map(zero), o: v.map(zero) };
}

function isFullEllipse(arc: { startingAngle: number; endingAngle: number; innerRadius: number } | undefined): boolean {
  if (!arc) return true;
  const sweep = Math.abs(arc.endingAngle - arc.startingAngle);
  return arc.innerRadius === 0 && Math.abs(sweep - 2 * Math.PI) < 1e-3;
}

function uniformRadius(node: FNode, mixed: symbol): number | null {
  if (node.cornerRadius === mixed) return null;
  if ((node.cornerSmoothing ?? 0) > 0 && (node.cornerRadius ?? 0) > 0) return null;
  return r3(node.cornerRadius ?? 0);
}

function shapeGeometry(node: FNode, ctx: Ctx): Geometry | null {
  const w = r3(node.width);
  const h = r3(node.height);
  const fromFill = (): PathGeometry | null => vectorPathsToGeometry(node.fillGeometry, ctx, node.name);
  switch (node.type) {
    case 'RECTANGLE':
    case 'FRAME':
    case 'COMPONENT':
    case 'COMPONENT_SET':
    case 'INSTANCE':
    case 'SECTION': {
      const r = uniformRadius(node, ctx.api.mixed);
      if (r !== null) return { type: 'rect', w, h, radius: r };
      return fromFill() ?? { type: 'rect', w, h, radius: 0 };
    }
    case 'ELLIPSE':
      if (isFullEllipse(node.arcData)) return { type: 'ellipse', w, h };
      return fromFill();
    case 'VECTOR':
      return vectorPathsToGeometry(node.vectorPaths, ctx, node.name) ?? fromFill();
    case 'LINE':
      return {
        type: 'path',
        paths: [{ c: false, v: [[0, 0], [w, 0]], i: [[0, 0], [0, 0]], o: [[0, 0], [0, 0]] }],
        rule: 'nonzero',
      };
    case 'POLYGON':
      return (node.cornerRadius ?? 0) > 0 ? fromFill() ?? polygonGeom() : polygonGeom();
    case 'STAR':
      return (node.cornerRadius ?? 0) > 0 ? fromFill() ?? starGeom() : starGeom();
    default:
      return fromFill();
  }
  function polygonGeom(): PathGeometry {
    return { type: 'path', paths: [regularPolygon(node.pointCount ?? 3, w, h, null)], rule: 'nonzero' };
  }
  function starGeom(): PathGeometry {
    return { type: 'path', paths: [regularPolygon(node.pointCount ?? 5, w, h, node.innerRadius ?? 0.382)], rule: 'nonzero' };
  }
}

// ─────────────────────────────── strokes ────────────────────────────────

const CAP: Record<string, StrokeCap> = { NONE: 'butt', ROUND: 'round', SQUARE: 'square' };
const JOIN: Record<string, StrokeJoin> = { MITER: 'miter', ROUND: 'round', BEVEL: 'bevel' };

async function convertStroke(node: FNode, geometry: Geometry | null, pctx: PaintContext, ctx: Ctx): Promise<Stroke | null> {
  if (!Array.isArray(node.strokes) || node.strokes.length === 0) return null;
  const { paints } = await convertPaints(node.strokes, pctx);
  const vectorPaints = paints.filter((p) => p.type !== 'image');
  if (vectorPaints.length !== paints.length) ctx.warn(`"${node.name}": image strokes are not supported`);
  if (vectorPaints.length === 0) return null;

  const mixed = ctx.api.mixed;
  let weight = node.strokeWeight;
  let uniform = true;
  if (weight === mixed || weight === undefined) {
    const sides = [node.strokeTopWeight, node.strokeRightWeight, node.strokeBottomWeight, node.strokeLeftWeight].filter(
      (x: unknown) => typeof x === 'number',
    ) as number[];
    weight = sides.length ? Math.max(...sides) : 1;
    uniform = sides.every((s) => s === sides[0]);
  }
  if (weight <= 0) return null;
  const align = node.strokeAlign === 'INSIDE' ? 'inside' : node.strokeAlign === 'OUTSIDE' ? 'outside' : 'center';
  const capRaw = node.strokeCap === mixed ? 'NONE' : (node.strokeCap ?? 'NONE');
  if (!CAP[capRaw]) ctx.warn(`"${node.name}": arrow/marker stroke caps are mapped to butt caps`);
  const joinRaw = node.strokeJoin === mixed ? 'MITER' : (node.strokeJoin ?? 'MITER');

  const parametric = geometry && (geometry.type === 'rect' || geometry.type === 'ellipse');
  const needsOutline = !uniform || (align !== 'center' && !parametric);
  let outline: PathGeometry | null = null;
  if (needsOutline) {
    outline = vectorPathsToGeometry(node.strokeGeometry, ctx, node.name);
    if (outline) outline.rule = 'nonzero';
  }
  return {
    paints: vectorPaints,
    weight: r3(weight),
    align,
    cap: CAP[capRaw] ?? 'butt',
    join: JOIN[joinRaw] ?? 'miter',
    miterLimit: r3(node.strokeMiterLimit ?? 4),
    dash: Array.isArray(node.dashPattern) ? node.dashPattern.map(r3) : [],
    uniform,
    outline,
  };
}

// ─────────────────────────────── traversal ──────────────────────────────

function maskType(node: FNode): MaskType {
  return node.maskType === 'VECTOR' ? 'vector' : node.maskType === 'LUMINANCE' ? 'luminance' : 'alpha';
}

function base(node: FNode, rootInv: Mat2x3, ctx: Ctx): Omit<ContainerNode, 'kind' | 'clips' | 'geometry' | 'fills' | 'stroke' | 'children'> {
  return {
    id: node.id,
    name: node.name || node.type,
    figmaType: node.type,
    visible: node.visible !== false,
    opacity: Math.round((node.opacity ?? 1) * 10000) / 10000,
    blendMode: mapBlendMode(node.blendMode),
    size: { w: r3(node.width ?? 0), h: r3(node.height ?? 0) },
    transform: roundMat(multiply(rootInv, fromFigma(node.absoluteTransform))),
    effects: convertEffects(node.effects, (m) => ctx.warn(m), node.name),
    isMask: node.isMask === true,
    maskType: maskType(node),
  };
}

function rasterNode(node: FNode, rootInv: Mat2x3, ctx: Ctx, reason: string): RasterNode {
  const b = node.absoluteRenderBounds ?? node.absoluteBoundingBox ?? { x: 0, y: 0, width: node.width, height: node.height };
  const scale = ctx.options.imageScale;
  ctx.warn(`"${node.name}": rasterised (${reason})`);
  return {
    ...base(node, rootInv, ctx),
    // render bounds are axis-aligned in canvas space: rotation is baked into the bitmap
    transform: roundMat(multiply(rootInv, translation(b.x, b.y))),
    size: { w: r3(b.width), h: r3(b.height) },
    kind: 'raster',
    asset: ctx.requestRaster(node),
    imageSize: { w: Math.max(1, Math.round(b.width * scale)), h: Math.max(1, Math.round(b.height * scale)) },
    reason,
    effects: [], // effects are baked into the export
  };
}

async function convertNode(node: FNode, rootInv: Mat2x3, ctx: Ctx, isRoot: boolean): Promise<F2Node | null> {
  if (SKIP_TYPES[node.type]) return null;
  if (!isRoot && node.visible === false && !ctx.options.includeHidden) return null;
  ctx.nodeCount++;
  if (ctx.onProgress && ctx.nodeCount % 250 === 0) ctx.onProgress(ctx.nodeCount);

  const size: Size = { w: node.width ?? 0, h: node.height ?? 0 };
  const pctx: PaintContext = {
    size,
    nodeName: node.name,
    warn: (m) => ctx.warn(m),
    imageSize: (h) => ctx.imageSize(h),
    requestImage: (h) => ctx.requestImage(h),
  };

  if (node.type === 'TEXT') {
    return { ...base(node, rootInv, ctx), kind: 'text', text: convertTextNode(node, ctx) };
  }

  if (CONTAINER_TYPES[node.type]) {
    const fills = await convertPaints(node.fills, pctx);
    if (fills.needsRaster) return rasterNode(node, rootInv, ctx, fills.needsRaster);
    const geometry = node.type === 'GROUP' ? null : shapeGeometry(node, ctx);
    const children: F2Node[] = [];
    for (const child of node.children ?? []) {
      const c = await convertNode(child, rootInv, ctx, false);
      if (c) children.push(c);
    }
    return {
      ...base(node, rootInv, ctx),
      kind: 'container',
      clips: node.type !== 'GROUP' && node.type !== 'SECTION' && node.clipsContent === true,
      geometry,
      fills: fills.paints,
      stroke: node.type === 'GROUP' ? null : await convertStroke(node, geometry, pctx, ctx),
      children,
    };
  }

  if (SHAPE_TYPES[node.type]) {
    const fills = await convertPaints(node.fills, pctx);
    if (fills.needsRaster) return rasterNode(node, rootInv, ctx, fills.needsRaster);
    const geometry = shapeGeometry(node, ctx);
    if (!geometry) return rasterNode(node, rootInv, ctx, 'no vector geometry available');
    const shape: ShapeNode = {
      ...base(node, rootInv, ctx),
      kind: 'shape',
      geometry,
      fills: fills.paints,
      stroke: await convertStroke(node, geometry, pctx, ctx),
    };
    return shape;
  }

  // STICKY, CONNECTOR, SHAPE_WITH_TEXT, TABLE, WIDGET, EMBED, MEDIA, …
  return rasterNode(node, rootInv, ctx, `${node.type.toLowerCase()} has no native AE equivalent`);
}

function convertTextNode(node: FNode, ctx: Ctx) {
  const t = convertText(node as TextSource, (m) => ctx.warn(m));
  for (const s of t.segments) ctx.fonts.set(`${s.font.family}\u0000${s.font.style}`, s.font);
  return t;
}

// ─────────────────────────────── assets ─────────────────────────────────

export function sniffMime(b: Uint8Array): ExtractedAsset['mime'] {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b.length > 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  return 'image/png';
}

/** Runs async tasks with a concurrency cap (keeps Figma responsive, bounds memory). */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function collectAssets(ctx: Ctx): Promise<ExtractedAsset[]> {
  const imageJobs = [...ctx.images.entries()].map(([hash, key]) => ({ kind: 'image' as const, hash, key }));
  const rasterJobs = ctx.rasters.map((r) => ({ kind: 'raster' as const, ...r }));
  const results = await mapLimit<(typeof imageJobs)[number] | (typeof rasterJobs)[number], ExtractedAsset | null>(
    [...imageJobs, ...rasterJobs],
    4,
    async (job) => {
      try {
        if (job.kind === 'image') {
          const img = ctx.api.getImageByHash(job.hash);
          if (!img) return null;
          const [bytes, size] = await Promise.all([img.getBytesAsync(), ctx.imageSize(job.hash)]);
          return { key: job.key, bytes, mime: sniffMime(bytes), width: size?.w ?? 0, height: size?.h ?? 0 };
        }
        const bytes: Uint8Array = await job.node.exportAsync({
          format: 'PNG',
          constraint: { type: 'SCALE', value: ctx.options.imageScale },
        });
        return { key: job.key, bytes, mime: 'image/png', width: 0, height: 0 };
      } catch (e) {
        ctx.warn(`asset ${job.key} failed to export: ${(e as Error).message}`);
        return null;
      }
    },
  );
  return results.filter((r): r is ExtractedAsset => r !== null);
}

// ─────────────────────────────── entry ──────────────────────────────────

export async function extractSelection(
  selection: readonly FNode[],
  options: BuildOptions,
  api: ExtractApi,
  meta: ExtractMeta,
  onProgress?: (nodes: number) => void,
): Promise<ExtractResult> {
  const ctx = new Ctx(api, options, onProgress);
  const roots: Root[] = [];
  for (const node of selection) {
    const bb = node.absoluteBoundingBox ?? { x: node.absoluteTransform[0][2], y: node.absoluteTransform[1][2], width: node.width, height: node.height };
    const rootInv = invert(translation(bb.x, bb.y));
    const converted = await convertNode(node, rootInv, ctx, true);
    if (!converted) continue;
    roots.push({
      node: converted,
      size: { w: Math.max(1, Math.ceil(bb.width - 1e-6)), h: Math.max(1, Math.ceil(bb.height - 1e-6)) },
      canvasOrigin: [r3(bb.x), r3(bb.y)],
    });
  }
  const assets = await collectAssets(ctx);
  const present = new Set(assets.map((a) => a.key));
  const document: F2AEDocument = {
    schemaVersion: 1,
    generator: { name: PRODUCT_NAME, version: PRODUCT_VERSION },
    createdAt: Date.now(),
    source: meta,
    options,
    roots,
    assets: assets.map((a) => ({ hash: a.key, mime: a.mime, width: a.width, height: a.height, byteLength: a.bytes.byteLength })),
    fonts: [...ctx.fonts.values()],
    warnings: ctx.warnings,
  };
  if (present.size !== ctx.images.size + ctx.rasters.length) {
    ctx.warn('some images could not be exported; affected layers will be empty');
  }
  return { document, assets };
}

/**
 * Rewrites provisional asset keys (img:/ras:) to content hashes. O(nodes + paints).
 * Unresolvable references are left in place; the AE builder reports them as warnings.
 */
export function rewriteAssetKeys(doc: F2AEDocument, map: ReadonlyMap<string, string>): void {
  for (const a of doc.assets) a.hash = map.get(a.hash) ?? a.hash;
  const fixPaints = (ps: { type: string; asset?: string }[] | undefined): void => {
    if (!ps) return;
    for (const p of ps) if (p.type === 'image' && p.asset) p.asset = map.get(p.asset) ?? p.asset;
  };
  const stack: F2Node[] = doc.roots.map((r) => r.node);
  while (stack.length) {
    const n = stack.pop()!;
    if (n.kind === 'raster') n.asset = map.get(n.asset) ?? n.asset;
    if (n.kind === 'shape' || n.kind === 'container') {
      fixPaints(n.fills);
      fixPaints(n.stroke?.paints);
    }
    if (n.kind === 'container') for (const c of n.children) stack.push(c);
  }
}
