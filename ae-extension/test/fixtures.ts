/** Schema node builders for builder tests. */
import { multiply, rotationDeg, translation } from '@f2ae/shared/matrix';
import {
  DEFAULT_BUILD_OPTIONS,
  type BuildOptions,
  type ContainerNode,
  type F2AEDocument,
  type Mat2x3,
  type Paint,
  type RasterNode,
  type SceneNode,
  type ShapeNode,
  type Stroke,
  type TextNode,
} from '@f2ae/shared/schema';

let seq = 0;

const base = (name: string, w: number, h: number, transform: Mat2x3) => ({
  id: `${++seq}:0`,
  name,
  figmaType: 'X',
  visible: true,
  opacity: 1,
  blendMode: 'normal' as const,
  size: { w, h },
  transform,
  effects: [],
  isMask: false,
  maskType: 'alpha' as const,
});

export const at = (x: number, y: number, deg = 0): Mat2x3 => (deg ? multiply(translation(x, y), rotationDeg(deg)) : translation(x, y));

export const solid = (r: number, g: number, b: number, opacity = 1): Paint => ({ type: 'solid', color: [r, g, b, 1], opacity, blendMode: 'normal' });

export function rect(name: string, w: number, h: number, t: Mat2x3, extra: Partial<ShapeNode> = {}): ShapeNode {
  return { ...base(name, w, h, t), kind: 'shape', geometry: { type: 'rect', w, h, radius: 0 }, fills: [solid(1, 0, 0)], stroke: null, ...extra };
}

export function frame(name: string, w: number, h: number, t: Mat2x3, children: SceneNode[], extra: Partial<ContainerNode> = {}): ContainerNode {
  return {
    ...base(name, w, h, t),
    figmaType: 'FRAME',
    kind: 'container',
    clips: false,
    geometry: { type: 'rect', w, h, radius: 0 },
    fills: [solid(1, 1, 1)],
    stroke: null,
    children,
    ...extra,
  };
}

export function group(name: string, w: number, h: number, t: Mat2x3, children: SceneNode[]): ContainerNode {
  return frame(name, w, h, t, children, { figmaType: 'GROUP', geometry: null, fills: [] });
}

export function text(name: string, chars: string, w: number, h: number, t: Mat2x3, extra: Partial<TextNode['text']> = {}): TextNode {
  return {
    ...base(name, w, h, t),
    kind: 'text',
    text: {
      characters: chars,
      autoResize: 'height',
      alignH: 'left',
      alignV: 'top',
      paragraphSpacing: 0,
      segments: [
        { start: 0, end: chars.length, font: { family: 'Inter', style: 'Bold' }, size: 20, lineHeight: 24, letterSpacing: 1, color: [0, 0, 1, 1], decoration: 'none', textCase: 'original' },
      ],
      ...extra,
    },
  };
}

export function raster(name: string, w: number, h: number, t: Mat2x3, asset: string): RasterNode {
  return { ...base(name, w, h, t), kind: 'raster', asset, imageSize: { w: w * 2, h: h * 2 }, reason: 'test' };
}

export function stroke(extra: Partial<Stroke> = {}): Stroke {
  return { paints: [solid(0, 0, 0)], weight: 2, align: 'center', cap: 'butt', join: 'miter', miterLimit: 4, dash: [], uniform: true, outline: null, ...extra };
}

export function doc(roots: { node: SceneNode; w: number; h: number; origin?: [number, number] }[], options: Partial<BuildOptions> = {}): F2AEDocument {
  return {
    schemaVersion: 1,
    generator: { name: 'test', version: '0' },
    createdAt: 0,
    source: { fileName: 'f', pageName: 'p' },
    options: { ...DEFAULT_BUILD_OPTIONS, ...options },
    roots: roots.map((r) => ({ node: r.node, size: { w: r.w, h: r.h }, canvasOrigin: r.origin ?? [0, 0] })),
    assets: [],
    fonts: [],
    warnings: [],
  };
}
