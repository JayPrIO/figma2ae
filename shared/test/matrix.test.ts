import { describe, expect, it } from 'vitest';
import {
  apply,
  decompose,
  fromFigma,
  identity,
  invert,
  isIdentity,
  multiply,
  rotationDeg,
  scaling,
  shearing,
  transformPath,
  translation,
} from '../src/matrix';
import type { Mat2x3 } from '../src/schema';

function close(a: Mat2x3, b: Mat2x3): void {
  for (let i = 0; i < 6; i++) expect(a[i]).toBeCloseTo(b[i], 7);
}

/** Recompose T · R · S · K from a decomposition. */
function recompose(d: ReturnType<typeof decompose>): Mat2x3 {
  return multiply(
    translation(d.tx, d.ty),
    multiply(rotationDeg(d.rotation), multiply(scaling(d.sx, d.sy), shearing(d.shear))),
  );
}

describe('matrix', () => {
  it('multiplies in the documented order (m1 · m2 applies m2 first)', () => {
    const m = multiply(translation(10, 0), scaling(2, 2));
    expect(apply(m, [1, 1])).toEqual([12, 2]);
  });

  it('inverts', () => {
    const m: Mat2x3 = [2, 0.5, -0.3, 1.5, 12, -7];
    close(multiply(m, invert(m)), identity());
    close(multiply(invert(m), m), identity());
  });

  it('never throws on singular matrices', () => {
    const inv = invert([0, 0, 0, 0, 5, 6]);
    expect(inv).toEqual([1, 0, 0, 1, -5, -6]);
  });

  it('converts Figma transforms', () => {
    expect(
      fromFigma([
        [1, 2, 3],
        [4, 5, 6],
      ]),
    ).toEqual([1, 4, 2, 5, 3, 6]);
  });

  it('rotation is clockwise in y-down space', () => {
    const p = apply(rotationDeg(90), [1, 0]);
    expect(p[0]).toBeCloseTo(0);
    expect(p[1]).toBeCloseTo(1);
  });

  it.each([
    ['identity', identity()],
    ['translate', translation(3, 4)],
    ['rotate 30', rotationDeg(30)],
    ['rotate -135 + scale', multiply(rotationDeg(-135), scaling(2, 0.5))],
    ['flip x', scaling(-1, 1)],
    ['flip y + rotate', multiply(rotationDeg(45), scaling(1, -1))],
    ['shear', multiply(rotationDeg(20), multiply(scaling(1.5, 2), shearing(0.3)))],
    ['arbitrary', [0.7, -1.2, 2.3, 0.4, 100, 50] as Mat2x3],
  ])('decompose round-trips: %s', (_name, m) => {
    const d = decompose(m as Mat2x3);
    close(recompose(d), m as Mat2x3);
  });

  it('reports zero shear for similarity transforms', () => {
    expect(decompose(multiply(rotationDeg(77), scaling(3, 3))).shear).toBe(0);
  });

  it('handles a zero-width x axis without NaN', () => {
    const d = decompose([0, 0, 0, 2, 1, 1]);
    expect(Number.isFinite(d.rotation)).toBe(true);
    expect(d.sy).toBe(2);
  });

  it('isIdentity', () => {
    expect(isIdentity(identity())).toBe(true);
    expect(isIdentity(translation(0.1, 0))).toBe(false);
  });

  it('transforms paths (tangents ignore translation)', () => {
    const p = transformPath({ c: true, v: [[1, 1]], i: [[1, 0]], o: [[0, 1]] }, multiply(translation(5, 5), scaling(2, 2)));
    expect(p).toEqual({ c: true, v: [[7, 7]], i: [[2, 0]], o: [[0, 2]] });
  });
});
