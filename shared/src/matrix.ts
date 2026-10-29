/**
 * 2×3 affine matrix math. ES5-SAFE: compiled into the ExtendScript builder.
 * Rules for this file: no classes, no ES2015+ built-ins (Math.hypot, Object.assign, …),
 * no iterators/spread on non-arrays. Pure functions, tuples allocated only on return.
 *
 * Mat2x3 = [a, b, c, d, tx, ty]:  x' = a·x + c·y + tx,  y' = b·x + d·y + ty
 */
import type { BezierPath, Mat2x3, Pt } from './schema';

export var EPS = 1e-9;
var RAD2DEG = 180 / Math.PI;

export function identity(): Mat2x3 {
  return [1, 0, 0, 1, 0, 0];
}

export function translation(tx: number, ty: number): Mat2x3 {
  return [1, 0, 0, 1, tx, ty];
}

export function scaling(sx: number, sy: number): Mat2x3 {
  return [sx, 0, 0, sy, 0, 0];
}

export function rotationDeg(deg: number): Mat2x3 {
  var r = deg / RAD2DEG;
  var cs = Math.cos(r);
  var sn = Math.sin(r);
  return [cs, sn, -sn, cs, 0, 0];
}

/** Returns m1 · m2 (apply m2 first, then m1). */
export function multiply(m1: Mat2x3, m2: Mat2x3): Mat2x3 {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function determinant(m: Mat2x3): number {
  return m[0] * m[3] - m[1] * m[2];
}

/** Inverse; degenerate matrices fall back to a translation-only inverse (never throws). */
export function invert(m: Mat2x3): Mat2x3 {
  var det = determinant(m);
  if (Math.abs(det) < EPS) {
    return [1, 0, 0, 1, -m[4], -m[5]];
  }
  var id = 1 / det;
  var a = m[3] * id;
  var b = -m[1] * id;
  var c = -m[2] * id;
  var d = m[0] * id;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function apply(m: Mat2x3, p: Pt): Pt {
  return [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
}

/** Applies only the linear part (for tangents / direction vectors). */
export function applyVector(m: Mat2x3, v: Pt): Pt {
  return [m[0] * v[0] + m[2] * v[1], m[1] * v[0] + m[3] * v[1]];
}

/** Figma `Transform` [[a, c, tx], [b, d, ty]] → Mat2x3. */
export function fromFigma(t: ReadonlyArray<ReadonlyArray<number>>): Mat2x3 {
  return [t[0][0], t[1][0], t[0][1], t[1][1], t[0][2], t[1][2]];
}

export interface Decomposed {
  tx: number;
  ty: number;
  /** degrees, clockwise in y-down space (After Effects convention) */
  rotation: number;
  sx: number;
  sy: number;
  /** horizontal shear factor k: L = R(rotation) · diag(sx, sy) · [[1, k], [0, 1]] */
  shear: number;
}

/**
 * QR-style decomposition: L = R(θ) · diag(sx, sy) · K(k), K = [[1, k], [0, 1]].
 * Reflections are folded into a negative sy, so rotation stays continuous.
 */
export function decompose(m: Mat2x3): Decomposed {
  var a = m[0];
  var b = m[1];
  var c = m[2];
  var d = m[3];
  var sx = Math.sqrt(a * a + b * b);
  if (sx < EPS) {
    // Degenerate x axis: derive rotation from the y axis instead.
    var syOnly = Math.sqrt(c * c + d * d);
    var rotY = syOnly < EPS ? 0 : Math.atan2(-c, d);
    return { tx: m[4], ty: m[5], rotation: rotY * RAD2DEG, sx: 0, sy: syOnly, shear: 0 };
  }
  var theta = Math.atan2(b, a);
  var cs = a / sx;
  var sn = b / sx;
  var mm = cs * c + sn * d;
  var sy = -sn * c + cs * d;
  var k = mm / sx;
  return { tx: m[4], ty: m[5], rotation: theta * RAD2DEG, sx: sx, sy: sy, shear: Math.abs(k) < 1e-7 ? 0 : k };
}

/** Shear matrix K(k) = [[1, k], [0, 1]]. */
export function shearing(k: number): Mat2x3 {
  return [1, 0, k, 1, 0, 0];
}

export function isIdentity(m: Mat2x3, tolerance?: number): boolean {
  var t = tolerance === undefined ? 1e-6 : tolerance;
  return (
    Math.abs(m[0] - 1) < t &&
    Math.abs(m[1]) < t &&
    Math.abs(m[2]) < t &&
    Math.abs(m[3] - 1) < t &&
    Math.abs(m[4]) < t &&
    Math.abs(m[5]) < t
  );
}

export function transformPath(path: BezierPath, m: Mat2x3): BezierPath {
  var n = path.v.length;
  var v: Pt[] = new Array(n);
  var ii: Pt[] = new Array(n);
  var oo: Pt[] = new Array(n);
  for (var k = 0; k < n; k++) {
    v[k] = apply(m, path.v[k]);
    ii[k] = applyVector(m, path.i[k]);
    oo[k] = applyVector(m, path.o[k]);
  }
  return { c: path.c, v: v, i: ii, o: oo };
}

export function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}
