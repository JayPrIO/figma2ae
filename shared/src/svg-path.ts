/**
 * SVG path data → After Effects bezier paths.
 *
 * Single-pass, allocation-light scanner (char codes, no regex, no token arrays).
 * Supports M L H V C S Q T Z (absolute + relative). Elliptical arcs (A) are converted to
 * cubic segments (Figma never emits them, but pasted/plugin-generated vectors may).
 * Complexity: O(n) in the length of the path string.
 */
import type { BezierPath, Pt } from './schema';

const enum Ch {
  Space = 32,
  Tab = 9,
  LF = 10,
  CR = 13,
  Comma = 44,
  Plus = 43,
  Minus = 45,
  Dot = 46,
  Zero = 48,
  Nine = 57,
  LowerE = 101,
  UpperE = 69,
}

export interface ParseResult {
  paths: BezierPath[];
  /** non-fatal issues encountered (e.g. malformed numbers); parsing stops at the first error */
  error: string | null;
}

const CLOSE_EPS = 1e-4;

class Scanner {
  i = 0;
  constructor(readonly s: string) {}

  skipSeparators(): void {
    const s = this.s;
    let i = this.i;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === Ch.Space || c === Ch.Comma || c === Ch.Tab || c === Ch.LF || c === Ch.CR) i++;
      else break;
    }
    this.i = i;
  }

  atNumber(): boolean {
    this.skipSeparators();
    if (this.i >= this.s.length) return false;
    const c = this.s.charCodeAt(this.i);
    return (c >= Ch.Zero && c <= Ch.Nine) || c === Ch.Minus || c === Ch.Plus || c === Ch.Dot;
  }

  number(): number {
    this.skipSeparators();
    const s = this.s;
    const start = this.i;
    let i = start;
    let c = s.charCodeAt(i);
    if (c === Ch.Minus || c === Ch.Plus) c = s.charCodeAt(++i);
    let digits = false;
    while (c >= Ch.Zero && c <= Ch.Nine) {
      c = s.charCodeAt(++i);
      digits = true;
    }
    if (c === Ch.Dot) {
      c = s.charCodeAt(++i);
      while (c >= Ch.Zero && c <= Ch.Nine) {
        c = s.charCodeAt(++i);
        digits = true;
      }
    }
    if (!digits) throw new Error(`Expected number at offset ${start}`);
    if (c === Ch.LowerE || c === Ch.UpperE) {
      const save = i;
      c = s.charCodeAt(++i);
      if (c === Ch.Minus || c === Ch.Plus) c = s.charCodeAt(++i);
      let expDigits = false;
      while (c >= Ch.Zero && c <= Ch.Nine) {
        c = s.charCodeAt(++i);
        expDigits = true;
      }
      if (!expDigits) i = save;
    }
    this.i = i;
    return +s.slice(start, i);
  }

  /** arc flags may be written without separators ("a1 1 0 011 1") */
  flag(): number {
    this.skipSeparators();
    const c = this.s.charCodeAt(this.i);
    if (c === 48 || c === 49) {
      this.i++;
      return c - 48;
    }
    throw new Error(`Expected flag at offset ${this.i}`);
  }
}

class Builder {
  paths: BezierPath[] = [];
  cur: BezierPath | null = null;
  /** current point */
  x = 0;
  y = 0;
  /** subpath start */
  sx = 0;
  sy = 0;

  moveTo(x: number, y: number): void {
    this.finish();
    this.cur = { c: false, v: [[x, y]], i: [[0, 0]], o: [[0, 0]] };
    this.x = this.sx = x;
    this.y = this.sy = y;
  }

  private ensure(): BezierPath {
    if (!this.cur) this.moveTo(this.x, this.y);
    return this.cur as BezierPath;
  }

  lineTo(x: number, y: number): void {
    const p = this.ensure();
    p.v.push([x, y]);
    p.i.push([0, 0]);
    p.o.push([0, 0]);
    this.x = x;
    this.y = y;
  }

  cubicTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void {
    const p = this.ensure();
    const last = p.v.length - 1;
    const lv = p.v[last];
    p.o[last] = [x1 - lv[0], y1 - lv[1]];
    p.v.push([x, y]);
    p.i.push([x2 - x, y2 - y]);
    p.o.push([0, 0]);
    this.x = x;
    this.y = y;
  }

  close(): void {
    const p = this.cur;
    if (!p) return;
    p.c = true;
    const n = p.v.length;
    if (n > 1) {
      const a = p.v[0];
      const b = p.v[n - 1];
      if (Math.abs(a[0] - b[0]) < CLOSE_EPS && Math.abs(a[1] - b[1]) < CLOSE_EPS) {
        // Duplicate closing vertex: fold its in-tangent into the first vertex.
        p.i[0] = p.i[n - 1];
        p.v.pop();
        p.i.pop();
        p.o.pop();
      }
    }
    this.x = this.sx;
    this.y = this.sy;
    this.finish();
  }

  finish(): void {
    if (this.cur && this.cur.v.length > 0) this.paths.push(this.cur);
    this.cur = null;
  }
}

/** Converts an SVG endpoint arc to cubic segments (SVG spec F.6). */
function arcTo(
  b: Builder,
  rx: number,
  ry: number,
  phiDeg: number,
  largeArc: number,
  sweep: number,
  x: number,
  y: number,
): void {
  const x0 = b.x;
  const y0 = b.y;
  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) {
    b.lineTo(x, y);
    return;
  }
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const sl = Math.sqrt(lambda);
    rx *= sl;
    ry *= sl;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cosP * cxp - sinP * cyp + (x0 + x) / 2;
  const cy = sinP * cxp + cosP * cyp + (y0 + y) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number): number => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const segs = Math.ceil(Math.abs(dt) / (Math.PI / 2) - 1e-9);
  const delta = dt / segs;
  const k = (4 / 3) * Math.tan(delta / 4);
  let t = t1;
  for (let s = 0; s < segs; s++) {
    const c1 = Math.cos(t);
    const s1 = Math.sin(t);
    const t2 = t + delta;
    const c2 = Math.cos(t2);
    const s2 = Math.sin(t2);
    const ex = (px: number, py: number): Pt => [cosP * rx * px - sinP * ry * py + cx, sinP * rx * px + cosP * ry * py + cy];
    const p1 = ex(c1 - k * s1, s1 + k * c1);
    const p2 = ex(c2 + k * s2, s2 - k * c2);
    const p3 = s === segs - 1 ? ([x, y] as Pt) : ex(c2, s2);
    b.cubicTo(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]);
    t = t2;
  }
}

/**
 * Parses SVG path data into AE-ready bezier paths (relative tangents).
 * Never throws: on malformed input returns what was parsed so far plus `error`.
 */
export function parseSvgPath(d: string): ParseResult {
  const sc = new Scanner(d);
  const b = new Builder();
  let cmd = 0;
  // reflected control points for S / T
  let lastCubicCx = 0;
  let lastCubicCy = 0;
  let lastQuadCx = 0;
  let lastQuadCy = 0;
  let prevCmd = 0;
  let error: string | null = null;

  try {
    for (;;) {
      sc.skipSeparators();
      if (sc.i >= d.length) break;
      const c = d.charCodeAt(sc.i);
      const isLetter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
      if (isLetter) {
        cmd = c;
        sc.i++;
      } else if (cmd === 0) {
        throw new Error(`Path must start with a command at offset ${sc.i}`);
      }
      // implicit repetition: after M, extra coordinate pairs are L
      const rel = cmd >= 97;
      const up = rel ? cmd - 32 : cmd;
      const ox = rel ? b.x : 0;
      const oy = rel ? b.y : 0;
      switch (up) {
        case 77: /* M */ {
          const x = sc.number() + ox;
          const y = sc.number() + oy;
          b.moveTo(x, y);
          cmd = rel ? 108 : 76; // subsequent pairs are lineTo
          break;
        }
        case 76: /* L */ {
          b.lineTo(sc.number() + ox, sc.number() + oy);
          break;
        }
        case 72: /* H */ {
          b.lineTo(sc.number() + ox, b.y);
          break;
        }
        case 86: /* V */ {
          b.lineTo(b.x, sc.number() + oy);
          break;
        }
        case 67: /* C */ {
          const x1 = sc.number() + ox;
          const y1 = sc.number() + oy;
          const x2 = sc.number() + ox;
          const y2 = sc.number() + oy;
          const x = sc.number() + ox;
          const y = sc.number() + oy;
          b.cubicTo(x1, y1, x2, y2, x, y);
          lastCubicCx = x2;
          lastCubicCy = y2;
          break;
        }
        case 83: /* S */ {
          const reflect = prevCmd === 67 || prevCmd === 83;
          const x1 = reflect ? 2 * b.x - lastCubicCx : b.x;
          const y1 = reflect ? 2 * b.y - lastCubicCy : b.y;
          const x2 = sc.number() + ox;
          const y2 = sc.number() + oy;
          const x = sc.number() + ox;
          const y = sc.number() + oy;
          b.cubicTo(x1, y1, x2, y2, x, y);
          lastCubicCx = x2;
          lastCubicCy = y2;
          break;
        }
        case 81: /* Q */ {
          const qx = sc.number() + ox;
          const qy = sc.number() + oy;
          const x = sc.number() + ox;
          const y = sc.number() + oy;
          quadTo(b, qx, qy, x, y);
          lastQuadCx = qx;
          lastQuadCy = qy;
          break;
        }
        case 84: /* T */ {
          const reflect = prevCmd === 81 || prevCmd === 84;
          const qx = reflect ? 2 * b.x - lastQuadCx : b.x;
          const qy = reflect ? 2 * b.y - lastQuadCy : b.y;
          const x = sc.number() + ox;
          const y = sc.number() + oy;
          quadTo(b, qx, qy, x, y);
          lastQuadCx = qx;
          lastQuadCy = qy;
          break;
        }
        case 65: /* A */ {
          const rx = sc.number();
          const ry = sc.number();
          const rot = sc.number();
          const large = sc.flag();
          const sweep = sc.flag();
          const x = sc.number() + ox;
          const y = sc.number() + oy;
          arcTo(b, rx, ry, rot, large, sweep, x, y);
          break;
        }
        case 90: /* Z */ {
          b.close();
          prevCmd = 90;
          cmd = 0;
          continue;
        }
        default:
          throw new Error(`Unsupported path command '${String.fromCharCode(cmd)}' at offset ${sc.i - 1}`);
      }
      prevCmd = up;
      // a command letter must follow unless more numbers repeat the command
      if (!sc.atNumber()) {
        sc.skipSeparators();
        if (sc.i < d.length) {
          const n = d.charCodeAt(sc.i);
          const letter = (n >= 65 && n <= 90) || (n >= 97 && n <= 122);
          if (!letter) throw new Error(`Unexpected character '${d[sc.i]}' at offset ${sc.i}`);
        }
      }
    }
  } catch (e) {
    error = (e as Error).message;
  }
  b.finish();
  return { paths: b.paths, error };
}

function quadTo(b: Builder, qx: number, qy: number, x: number, y: number): void {
  const x0 = b.x;
  const y0 = b.y;
  b.cubicTo(x0 + (2 / 3) * (qx - x0), y0 + (2 / 3) * (qy - y0), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y);
}

/** Rounds all coordinates in place to 3 decimals (payload size + determinism). */
export function roundPaths(paths: BezierPath[]): BezierPath[] {
  for (const p of paths) {
    for (const arr of [p.v, p.i, p.o]) {
      for (const pt of arr) {
        pt[0] = Math.round(pt[0] * 1000) / 1000;
        pt[1] = Math.round(pt[1] * 1000) / 1000;
        // normalise -0
        if (pt[0] === 0) pt[0] = 0;
        if (pt[1] === 0) pt[1] = 0;
      }
    }
  }
  return paths;
}
