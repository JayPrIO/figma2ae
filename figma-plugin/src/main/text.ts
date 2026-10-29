/** Figma TextNode → F2AE TextData. */
import type { TextAlignH, TextAlignV, TextAutoResize, TextCase, TextData, TextDecoration, TextSegment } from '@f2ae/shared/schema';
import { rgba } from './paints';

const AUTO_RESIZE: Record<string, TextAutoResize> = {
  NONE: 'none',
  HEIGHT: 'height',
  WIDTH_AND_HEIGHT: 'widthAndHeight',
  TRUNCATE: 'truncate',
};
const ALIGN_H: Record<string, TextAlignH> = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justified' };
const ALIGN_V: Record<string, TextAlignV> = { TOP: 'top', CENTER: 'center', BOTTOM: 'bottom' };
const CASE: Record<string, TextCase> = {
  ORIGINAL: 'original',
  UPPER: 'upper',
  LOWER: 'lower',
  TITLE: 'title',
  SMALL_CAPS: 'smallCaps',
  SMALL_CAPS_FORCED: 'smallCaps',
};
const DECO: Record<string, TextDecoration> = { NONE: 'none', UNDERLINE: 'underline', STRIKETHROUGH: 'strikethrough' };

export const SEGMENT_FIELDS = ['fontName', 'fontSize', 'fills', 'letterSpacing', 'lineHeight', 'textDecoration', 'textCase'] as const;

interface FigmaSegment {
  start: number;
  end: number;
  fontName: { family: string; style: string };
  fontSize: number;
  fills: ReadonlyArray<{ type: string; visible?: boolean; opacity?: number; color?: { r: number; g: number; b: number } }>;
  letterSpacing: { unit: 'PIXELS' | 'PERCENT'; value: number };
  lineHeight: { unit: 'AUTO' } | { unit: 'PIXELS' | 'PERCENT'; value: number };
  textDecoration: string;
  textCase: string;
}

export interface TextSource {
  name: string;
  characters: string;
  textAutoResize: string;
  textAlignHorizontal: string;
  textAlignVertical: string;
  paragraphSpacing: number;
  getStyledTextSegments(fields: readonly string[]): ReadonlyArray<FigmaSegment>;
}

const r3 = (x: number): number => Math.round(x * 1000) / 1000;

export function convertText(node: TextSource, warn: (m: string) => void): TextData {
  const raw = node.getStyledTextSegments(SEGMENT_FIELDS);
  let gradientWarned = false;
  const segments: TextSegment[] = raw.map((s) => {
    const fill = s.fills.find((f) => f.visible !== false);
    let color = null;
    if (fill && fill.type === 'SOLID' && fill.color) color = rgba(fill.color, fill.opacity ?? 1);
    else if (fill && !gradientWarned) {
      gradientWarned = true;
      warn(`"${node.name}": ${fill.type.toLowerCase()} text fill is not supported by AE text; using first stop/black`);
    }
    const lh = s.lineHeight;
    const lineHeight = lh.unit === 'AUTO' ? null : lh.unit === 'PIXELS' ? r3(lh.value) : r3((lh.value / 100) * s.fontSize);
    const ls = s.letterSpacing;
    const letterSpacing = ls.unit === 'PIXELS' ? r3(ls.value) : r3((ls.value / 100) * s.fontSize);
    return {
      start: s.start,
      end: s.end,
      font: { family: s.fontName.family, style: s.fontName.style },
      size: r3(s.fontSize),
      lineHeight,
      letterSpacing,
      color,
      decoration: DECO[s.textDecoration] ?? 'none',
      textCase: CASE[s.textCase] ?? 'original',
    };
  });
  return {
    characters: node.characters,
    autoResize: AUTO_RESIZE[node.textAutoResize] ?? 'none',
    alignH: ALIGN_H[node.textAlignHorizontal] ?? 'left',
    alignV: ALIGN_V[node.textAlignVertical] ?? 'top',
    paragraphSpacing: r3(node.paragraphSpacing || 0),
    segments,
  };
}
