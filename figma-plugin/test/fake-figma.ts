/** Minimal stand-ins for Figma nodes, enough to drive the extractor deterministically. */
import type { ExtractApi } from '../src/main/extract';

export const MIXED = Symbol('mixed');

type T = [[number, number, number], [number, number, number]];

export const tx = (x: number, y: number): T => [
  [1, 0, x],
  [0, 1, y],
];

export function rot(deg: number, x: number, y: number): T {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    [c, -s, x],
    [s, c, y],
  ];
}

let ids = 0;

export function node(type: string, props: Record<string, unknown> = {}): Record<string, unknown> {
  const width = (props.width as number) ?? 100;
  const height = (props.height as number) ?? 50;
  const at = (props.absoluteTransform as T) ?? tx(0, 0);
  return {
    id: `${++ids}:1`,
    name: `${type.toLowerCase()} ${ids}`,
    type,
    visible: true,
    opacity: 1,
    blendMode: 'PASS_THROUGH',
    width,
    height,
    absoluteTransform: at,
    absoluteBoundingBox: { x: at[0][2], y: at[1][2], width, height },
    absoluteRenderBounds: { x: at[0][2], y: at[1][2], width, height },
    effects: [],
    fills: [],
    strokes: [],
    strokeWeight: 1,
    strokeAlign: 'CENTER',
    strokeCap: 'NONE',
    strokeJoin: 'MITER',
    strokeMiterLimit: 4,
    dashPattern: [],
    cornerRadius: 0,
    cornerSmoothing: 0,
    isMask: false,
    maskType: 'ALPHA',
    clipsContent: false,
    fillGeometry: [],
    strokeGeometry: [],
    exportAsync: async () => new Uint8Array([137, 80, 78, 71, (ids % 255) + 1]),
    ...props,
  };
}

export function solid(r: number, g: number, b: number, opacity = 1) {
  return { type: 'SOLID', visible: true, opacity, blendMode: 'NORMAL', color: { r, g, b } };
}

export function text(chars: string, props: Record<string, unknown> = {}) {
  const segs = (props.segments as unknown[]) ?? [
    {
      start: 0,
      end: chars.length,
      characters: chars,
      fontName: { family: 'Inter', style: 'Bold' },
      fontSize: 24,
      fills: [solid(0, 0, 0)],
      letterSpacing: { unit: 'PERCENT', value: 10 },
      lineHeight: { unit: 'PERCENT', value: 150 },
      textDecoration: 'NONE',
      textCase: 'UPPER',
    },
  ];
  return node('TEXT', {
    characters: chars,
    textAutoResize: 'WIDTH_AND_HEIGHT',
    textAlignHorizontal: 'CENTER',
    textAlignVertical: 'TOP',
    paragraphSpacing: 0,
    getStyledTextSegments: () => segs,
    ...props,
  });
}

export function fakeApi(images: Record<string, { bytes: Uint8Array; w: number; h: number }> = {}): ExtractApi {
  return {
    mixed: MIXED,
    getImageByHash: (h) => {
      const img = images[h];
      if (!img) return null;
      return { getBytesAsync: async () => img.bytes, getSizeAsync: async () => ({ width: img.w, height: img.h }) };
    },
  };
}
