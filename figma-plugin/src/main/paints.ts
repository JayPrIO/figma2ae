/**
 * Figma paint / stroke / effect / blend-mode conversion into the F2AE schema.
 * Pure functions over plain data — unit-testable without the Figma runtime.
 */
import { apply, fromFigma, invert, multiply, rotationDeg, scaling, translation } from '@f2ae/shared/matrix';
import type {
  BlendMode,
  Effect,
  GradientPaint,
  ImagePaint,
  Mat2x3,
  Paint,
  Pt,
  RGBA,
  Size,
  SolidPaint,
} from '@f2ae/shared/schema';

const BLEND: Record<string, BlendMode> = {
  PASS_THROUGH: 'normal',
  NORMAL: 'normal',
  DARKEN: 'darken',
  MULTIPLY: 'multiply',
  LINEAR_BURN: 'linearBurn',
  COLOR_BURN: 'colorBurn',
  LIGHTEN: 'lighten',
  SCREEN: 'screen',
  LINEAR_DODGE: 'linearDodge',
  COLOR_DODGE: 'colorDodge',
  OVERLAY: 'overlay',
  SOFT_LIGHT: 'softLight',
  HARD_LIGHT: 'hardLight',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

export function mapBlendMode(b: string | undefined): BlendMode {
  return (b && BLEND[b]) || 'normal';
}

const r4 = (x: number): number => Math.round(x * 10000) / 10000;
const r3 = (x: number): number => Math.round(x * 1000) / 1000;
const pt3 = (p: Pt): Pt => [r3(p[0]), r3(p[1])];

export function rgba(c: { r: number; g: number; b: number; a?: number }, alpha?: number): RGBA {
  return [r4(c.r), r4(c.g), r4(c.b), r4(alpha ?? c.a ?? 1)];
}

/** Request for image bytes, resolved after traversal (keyed by provisional asset key). */
export interface ImageRequest {
  key: string;
  imageHash: string;
}

export interface PaintContext {
  size: Size;
  warn(msg: string): void;
  /** returns image pixel size for a Figma image hash (cached, async in Figma) */
  imageSize(hash: string): Promise<Size | null>;
  /** registers an image for upload and returns its provisional asset key */
  requestImage(hash: string): string;
  nodeName: string;
}

type FigmaPaint = {
  type: string;
  visible?: boolean;
  opacity?: number;
  blendMode?: string;
  color?: { r: number; g: number; b: number };
  gradientTransform?: ReadonlyArray<ReadonlyArray<number>>;
  gradientStops?: ReadonlyArray<{ position: number; color: { r: number; g: number; b: number; a: number } }>;
  scaleMode?: 'FILL' | 'FIT' | 'CROP' | 'TILE';
  imageHash?: string | null;
  imageTransform?: ReadonlyArray<ReadonlyArray<number>>;
  rotation?: number;
  filters?: Record<string, number>;
};

export function gradientHandles(t: ReadonlyArray<ReadonlyArray<number>>, size: Size, radial: boolean): { start: Pt; end: Pt; elliptical: boolean } {
  // gradientTransform maps node-normalised space → gradient space, where a linear gradient
  // runs (0, .5) → (1, .5) and a radial one is centred at (.5, .5) with radius .5.
  const inv = invert(fromFigma(t));
  const toPx = scaling(size.w, size.h);
  const m = multiply(toPx, inv);
  if (!radial) return { start: pt3(apply(m, [0, 0.5])), end: pt3(apply(m, [1, 0.5])), elliptical: false };
  const c = apply(m, [0.5, 0.5]);
  const ex = apply(m, [1, 0.5]);
  const ey = apply(m, [0.5, 1]);
  const rx = Math.sqrt((ex[0] - c[0]) ** 2 + (ex[1] - c[1]) ** 2);
  const ry = Math.sqrt((ey[0] - c[0]) ** 2 + (ey[1] - c[1]) ** 2);
  const elliptical = Math.abs(rx - ry) > Math.max(0.5, 0.01 * Math.max(rx, ry));
  return { start: pt3(c), end: pt3(ex), elliptical };
}

/** Image pixel space → node-local placement for FILL / FIT / CROP. Returns null for TILE. */
export function imagePlacement(p: FigmaPaint, img: Size, node: Size): Mat2x3 | null {
  const mode = p.scaleMode ?? 'FILL';
  if (mode === 'TILE') return null;
  if (mode === 'CROP') {
    const t = p.imageTransform ? fromFigma(p.imageTransform) : ([1, 0, 0, 1, 0, 0] as Mat2x3);
    // imageTransform maps node-normalised → image-normalised space.
    return multiply(scaling(node.w, node.h), multiply(invert(t), scaling(1 / img.w, 1 / img.h)));
  }
  const rot = (((p.rotation ?? 0) % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const iw = swap ? img.h : img.w;
  const ih = swap ? img.w : img.h;
  const s = mode === 'FIT' ? Math.min(node.w / iw, node.h / ih) : Math.max(node.w / iw, node.h / ih);
  return multiply(
    translation(node.w / 2, node.h / 2),
    multiply(rotationDeg(rot), multiply(scaling(s, s), translation(-img.w / 2, -img.h / 2))),
  );
}

export interface ConvertedPaints {
  paints: Paint[];
  /** a paint could not be represented natively (TILE image) → caller should rasterise */
  needsRaster: string | null;
}

export async function convertPaints(input: ReadonlyArray<FigmaPaint> | symbol | undefined, ctx: PaintContext): Promise<ConvertedPaints> {
  const out: Paint[] = [];
  if (!Array.isArray(input)) return { paints: out, needsRaster: null };
  for (const p of input as FigmaPaint[]) {
    if (p.visible === false) continue;
    const opacity = r4(p.opacity ?? 1);
    const blendMode = mapBlendMode(p.blendMode);
    switch (p.type) {
      case 'SOLID': {
        const s: SolidPaint = { type: 'solid', color: rgba(p.color!, 1), opacity, blendMode };
        out.push(s);
        break;
      }
      case 'GRADIENT_LINEAR':
      case 'GRADIENT_RADIAL':
      case 'GRADIENT_ANGULAR':
      case 'GRADIENT_DIAMOND': {
        const radial = p.type !== 'GRADIENT_LINEAR';
        const h = gradientHandles(p.gradientTransform ?? [[1, 0, 0], [0, 1, 0]], ctx.size, radial);
        const approximated = p.type === 'GRADIENT_ANGULAR' || p.type === 'GRADIENT_DIAMOND' || h.elliptical;
        if (approximated) ctx.warn(`"${ctx.nodeName}": ${p.type.toLowerCase().replace('gradient_', '')} gradient approximated as radial`);
        const g: GradientPaint = {
          type: radial ? 'radial' : 'linear',
          stops: (p.gradientStops ?? []).map((s) => ({ pos: r4(s.position), color: rgba(s.color) })),
          start: h.start,
          end: h.end,
          opacity,
          blendMode,
          approximated,
        };
        out.push(g);
        break;
      }
      case 'IMAGE': {
        if (!p.imageHash) continue;
        if (p.scaleMode === 'TILE') return { paints: out, needsRaster: 'tiled image fill' };
        const img = await ctx.imageSize(p.imageHash);
        if (!img) {
          ctx.warn(`"${ctx.nodeName}": image could not be read, skipped`);
          continue;
        }
        if (p.filters && Object.values(p.filters).some((v) => v !== 0)) {
          ctx.warn(`"${ctx.nodeName}": image adjustments (exposure, contrast…) are not transferred`);
        }
        const placement = imagePlacement(p, img, ctx.size)!;
        const ip: ImagePaint = {
          type: 'image',
          asset: ctx.requestImage(p.imageHash),
          imageSize: img,
          placement: placement.map(r4) as Mat2x3,
          opacity,
          blendMode,
          scaleMode: (p.scaleMode ?? 'FILL').toLowerCase() as ImagePaint['scaleMode'],
        };
        out.push(ip);
        break;
      }
      case 'VIDEO':
        return { paints: out, needsRaster: 'video fill' };
      default:
        ctx.warn(`"${ctx.nodeName}": unsupported paint type ${p.type} skipped`);
    }
  }
  return { paints: out, needsRaster: null };
}

type FigmaEffect = {
  type: string;
  visible?: boolean;
  color?: { r: number; g: number; b: number; a: number };
  offset?: { x: number; y: number };
  radius?: number;
  spread?: number;
  blendMode?: string;
  blurType?: string;
};

export function convertEffects(input: ReadonlyArray<FigmaEffect> | undefined, warn: (m: string) => void, nodeName: string): Effect[] {
  const out: Effect[] = [];
  if (!Array.isArray(input)) return out;
  for (const e of input as FigmaEffect[]) {
    if (e.visible === false) continue;
    switch (e.type) {
      case 'DROP_SHADOW':
      case 'INNER_SHADOW':
        out.push({
          type: e.type === 'DROP_SHADOW' ? 'dropShadow' : 'innerShadow',
          color: rgba(e.color ?? { r: 0, g: 0, b: 0, a: 0.25 }),
          offset: [r3(e.offset?.x ?? 0), r3(e.offset?.y ?? 0)],
          radius: r3(e.radius ?? 0),
          spread: r3(e.spread ?? 0),
          blendMode: mapBlendMode(e.blendMode),
        });
        break;
      case 'LAYER_BLUR':
      case 'BACKGROUND_BLUR':
        if (e.blurType === 'PROGRESSIVE') warn(`"${nodeName}": progressive blur mapped to uniform blur`);
        out.push({ type: e.type === 'LAYER_BLUR' ? 'layerBlur' : 'backgroundBlur', radius: r3(e.radius ?? 0) });
        break;
      default:
        warn(`"${nodeName}": effect ${e.type} is not supported`);
    }
  }
  return out;
}
