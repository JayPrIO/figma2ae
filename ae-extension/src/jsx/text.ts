/**
 * Text layer recreation.
 *  - WIDTH_AND_HEIGHT → point text; everything else → paragraph (box) text.
 *  - Base style = first segment; per-segment styles via TextDocument.characterRange (AE 24.3+),
 *    otherwise the dominant style is used and a warning is emitted.
 *  - Fonts resolved through app.fonts (AE 24+) to PostScript names, else a heuristic name;
 *    a post-apply read-back detects substitutions.
 * Returns the layer plus the layer-space offset of node-local (0,0) for placement.
 */
import type { Pt, TextData, TextNode, TextSegment } from '@f2ae/shared/schema';
import { warn, type Warnings } from './util';

var fontCache: { [k: string]: string } = {};

export function resetFontCache(): void {
  fontCache = {};
}

function stripSpaces(s: string): string {
  return s.replace(/\s+/g, '');
}

export function postScriptName(family: string, style: string): string {
  var key = family + '\u0000' + style;
  if (fontCache[key] !== undefined) return fontCache[key];
  var ps = '';
  try {
    if (app.fonts && typeof app.fonts.getFontsByFamilyNameAndStyleName === 'function') {
      var found = app.fonts.getFontsByFamilyNameAndStyleName(family, style);
      if (found && found.length > 0) ps = found[0].postScriptName;
    }
  } catch (e) {
    /* fall through to heuristic */
  }
  if (!ps) {
    var st = stripSpaces(style);
    ps = stripSpaces(family) + (st && st !== 'Regular' ? '-' + st : '');
  }
  fontCache[key] = ps;
  return ps;
}

function applyCase(text: string, segs: TextSegment[]): string {
  // per-segment case transform, length-preserving (characterRange indices must stay valid)
  var out = '';
  for (var s = 0; s < segs.length; s++) {
    var seg = segs[s];
    var piece = text.substring(seg.start, seg.end);
    if (seg.textCase === 'upper' || seg.textCase === 'lower') {
      var conv = '';
      for (var i = 0; i < piece.length; i++) {
        var ch = piece.charAt(i);
        var c2 = seg.textCase === 'upper' ? ch.toUpperCase() : ch.toLowerCase();
        conv += c2.length === 1 ? c2 : ch;
      }
      piece = conv;
    } else if (seg.textCase === 'title') {
      var t = '';
      for (var j = 0; j < piece.length; j++) {
        var prev = j === 0 ? (seg.start === 0 ? ' ' : text.charAt(seg.start - 1)) : piece.charAt(j - 1);
        var cj = piece.charAt(j);
        var up = cj.toUpperCase();
        t += /\s/.test(prev) && up.length === 1 ? up : cj;
      }
      piece = t;
    }
    out += piece;
  }
  if (out.length !== text.length) return text;
  // Figma newlines → AE paragraph returns; line separators → AE soft returns (ETX)
  return out.replace(/\r\n|\n/g, '\r').replace(/\u2028/g, '\u0003');
}

function justification(align: TextData['alignH']): any {
  if (align === 'center') return ParagraphJustification.CENTER_JUSTIFY;
  if (align === 'right') return ParagraphJustification.RIGHT_JUSTIFY;
  if (align === 'justified') return ParagraphJustification.FULL_JUSTIFY_LASTLINE_LEFT;
  return ParagraphJustification.LEFT_JUSTIFY;
}

function styleInto(target: any, seg: TextSegment): void {
  target.font = postScriptName(seg.font.family, seg.font.style);
  target.fontSize = seg.size;
  target.applyFill = true;
  var c = seg.color || [0, 0, 0, 1];
  target.fillColor = [c[0], c[1], c[2]];
  target.applyStroke = false;
  // AE only accepts integer tracking (1/1000 em)
  target.tracking = seg.size > 0 ? Math.round((seg.letterSpacing / seg.size) * 1000) : 0;
  if (seg.lineHeight === null) {
    target.autoLeading = true;
  } else {
    target.autoLeading = false;
    target.leading = seg.lineHeight;
  }
  try {
    if (seg.decoration !== 'none') {
      target.underline = seg.decoration === 'underline';
      target.strikethrough = seg.decoration === 'strikethrough';
    }
    if (seg.textCase === 'smallCaps') target.smallCaps = true;
  } catch (e) {
    /* read-only on older AE: ignored */
  }
}

function dominant(segs: TextSegment[]): TextSegment {
  var best = segs[0];
  for (var i = 1; i < segs.length; i++) if (segs[i].end - segs[i].start > best.end - best.start) best = segs[i];
  return best;
}

export interface TextBuild {
  layer: any;
  /** layer-space position of node-local (0,0) */
  offset: Pt;
}

export function buildText(comp: any, node: TextNode, w: Warnings): TextBuild {
  var t = node.text;
  var segs = t.segments.length > 0 ? t.segments : [
    { start: 0, end: t.characters.length, font: { family: 'Arial', style: 'Regular' }, size: 12, lineHeight: null, letterSpacing: 0, color: [0, 0, 0, 1] as any, decoration: 'none' as const, textCase: 'original' as const },
  ];
  var isBox = t.autoResize !== 'widthAndHeight';
  var bw = node.size.w + 2; // 1px slack each side: AE metrics occasionally wrap a line early
  var layer = isBox ? comp.layers.addBoxText([bw, Math.max(1, node.size.h)]) : comp.layers.addText();
  layer.name = node.name;
  var prop = layer.property('ADBE Text Properties').property('ADBE Text Document');
  var td = prop.value;
  try {
    td.resetCharStyle();
    td.resetParagraphStyle();
  } catch (e) {
    /* AE < 13.6 */
  }
  td.text = applyCase(t.characters, segs);
  var base = typeof td.characterRange === 'function' ? segs[0] : dominant(segs);
  styleInto(td, base);
  td.justification = justification(t.alignH);
  if (t.alignV !== 'top' && isBox) {
    try {
      td.boxVerticalAlignment = t.alignV === 'center' ? 1 : 2;
    } catch (e) {
      warn(w, '"' + node.name + '": vertical text alignment needs a newer After Effects');
    }
  }

  if (segs.length > 1) {
    if (typeof td.characterRange === 'function') {
      for (var i = 0; i < segs.length; i++) {
        var s = segs[i];
        if (s.end <= s.start) continue;
        try {
          styleInto(td.characterRange(s.start, s.end), s);
        } catch (e) {
          warn(w, '"' + node.name + '": some character styles could not be applied');
        }
      }
    } else {
      warn(w, '"' + node.name + '": mixed text styles need After Effects 24.3+; dominant style used');
    }
  }
  prop.setValue(td);

  var applied = prop.value;
  var wanted = postScriptName(base.font.family, base.font.style);
  if (applied && applied.font && applied.font !== wanted) {
    warn(w, 'Font "' + base.font.family + ' ' + base.font.style + '" is not installed; After Effects substituted "' + applied.font + '"');
  }

  var offset: Pt;
  if (isBox) {
    var bp: Pt = [-bw / 2, -node.size.h / 2];
    try {
      var p = applied.boxTextPos;
      if (p && p.length === 2) bp = [p[0], p[1]];
    } catch (e) {
      /* default: box centred on the layer origin */
    }
    offset = [bp[0] + 1, bp[1]];
  } else {
    // point text: horizontal origin follows justification; vertically centre glyph bounds
    var ox = t.alignH === 'center' ? -node.size.w / 2 : t.alignH === 'right' ? -node.size.w : 0;
    var r = layer.sourceRectAtTime(0, false);
    var oy = r.top + r.height / 2 - node.size.h / 2;
    offset = [ox, oy];
  }
  return { layer: layer, offset: offset };
}
