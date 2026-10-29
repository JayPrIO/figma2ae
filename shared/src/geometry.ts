/**
 * Parametric geometry → bezier conversions. ES5-SAFE (used by the ExtendScript builder
 * when a parametric shape must be baked, e.g. sheared layers).
 */
import type { BezierPath, Geometry, PathGeometry } from './schema';

/** Cubic approximation constant for quarter circles. */
export var KAPPA = 0.5522847498307936;

export function ellipseToPath(w: number, h: number): BezierPath {
  var rx = w / 2;
  var ry = h / 2;
  var kx = rx * KAPPA;
  var ky = ry * KAPPA;
  return {
    c: true,
    v: [
      [rx, 0],
      [w, ry],
      [rx, h],
      [0, ry],
    ],
    i: [
      [-kx, 0],
      [0, -ky],
      [kx, 0],
      [0, ky],
    ],
    o: [
      [kx, 0],
      [0, ky],
      [-kx, 0],
      [0, -ky],
    ],
  };
}

export function rectToPath(w: number, h: number, radius: number): BezierPath {
  var r = Math.max(0, Math.min(radius, w / 2, h / 2));
  if (r <= 0) {
    return {
      c: true,
      v: [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ],
      i: [
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
      ],
      o: [
        [0, 0],
        [0, 0],
        [0, 0],
        [0, 0],
      ],
    };
  }
  var k = r * KAPPA;
  return {
    c: true,
    v: [
      [r, 0],
      [w - r, 0],
      [w, r],
      [w, h - r],
      [w - r, h],
      [r, h],
      [0, h - r],
      [0, r],
    ],
    i: [
      [-k, 0],
      [0, 0],
      [0, -k],
      [0, 0],
      [k, 0],
      [0, 0],
      [0, k],
      [0, 0],
    ],
    o: [
      [0, 0],
      [k, 0],
      [0, 0],
      [0, k],
      [0, 0],
      [-k, 0],
      [0, 0],
      [0, -k],
    ],
  };
}

/** Normalises any geometry to a path geometry. */
export function geometryToPath(g: Geometry): PathGeometry {
  if (g.type === 'path') return g;
  if (g.type === 'rect') return { type: 'path', paths: [rectToPath(g.w, g.h, g.radius)], rule: 'nonzero' };
  return { type: 'path', paths: [ellipseToPath(g.w, g.h)], rule: 'nonzero' };
}
