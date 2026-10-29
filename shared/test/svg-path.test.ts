import { describe, expect, it } from 'vitest';
import { parseSvgPath, roundPaths } from '../src/svg-path';
import { ellipseToPath, geometryToPath, KAPPA, rectToPath } from '../src/geometry';

describe('parseSvgPath', () => {
  it('parses Figma-style absolute closed paths and folds the duplicate closing vertex', () => {
    const { paths, error } = parseSvgPath('M 0 0 L 10 0 L 10 10 L 0 0 Z');
    expect(error).toBeNull();
    expect(paths).toHaveLength(1);
    expect(paths[0].c).toBe(true);
    expect(paths[0].v).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
  });

  it('keeps open paths open', () => {
    const { paths } = parseSvgPath('M0 0L5 5');
    expect(paths[0].c).toBe(false);
    expect(paths[0].v).toHaveLength(2);
  });

  it('stores cubic control points as relative tangents', () => {
    const { paths } = parseSvgPath('M 0 0 C 0 10 20 10 20 0');
    const p = paths[0];
    expect(p.o[0]).toEqual([0, 10]);
    expect(p.i[1]).toEqual([0, 10]);
    expect(p.v[1]).toEqual([20, 0]);
  });

  it('moves the closing in-tangent onto the first vertex', () => {
    const { paths } = parseSvgPath('M 0 0 L 10 0 C 10 5 5 0 0 0 Z');
    const p = paths[0];
    expect(p.v).toHaveLength(2);
    expect(p.i[0]).toEqual([5, 0]);
    expect(p.o[1]).toEqual([0, 5]);
  });

  it('handles relative commands, H/V and implicit lineTo after M', () => {
    const { paths, error } = parseSvgPath('m10 10 5 0 v5 h-5 z');
    expect(error).toBeNull();
    expect(paths[0].v).toEqual([
      [10, 10],
      [15, 10],
      [15, 15],
      [10, 15],
    ]);
  });

  it('converts quadratics to equivalent cubics', () => {
    const { paths } = parseSvgPath('M0 0 Q 3 3 6 0');
    expect(paths[0].o[0][0]).toBeCloseTo(2);
    expect(paths[0].o[0][1]).toBeCloseTo(2);
    expect(paths[0].i[1][0]).toBeCloseTo(-2);
    expect(paths[0].i[1][1]).toBeCloseTo(2);
  });

  it('reflects control points for S and T', () => {
    const s = parseSvgPath('M0 0 C 0 5 5 5 5 0 S 10 -5 10 0').paths[0];
    // reflected cp1 = 2*(5,0) - (5,5) = (5,-5) → relative to vertex (5,0) = (0,-5)
    expect(s.o[1]).toEqual([0, -5]);
    const t = parseSvgPath('M0 0 Q 2 2 4 0 T 8 0').paths[0];
    expect(t.v).toHaveLength(3);
  });

  it('parses multiple subpaths, compact numbers and exponents', () => {
    const { paths, error } = parseSvgPath('M0,0L1e1,0-5.5.5ZM20 20L30 30');
    expect(error).toBeNull();
    expect(paths).toHaveLength(2);
    expect(paths[0].v[1]).toEqual([10, 0]);
    expect(paths[0].v[2]).toEqual([-5.5, 0.5]);
  });

  it('approximates arcs with cubic segments that end exactly on the endpoint', () => {
    const { paths, error } = parseSvgPath('M 0 50 A 50 50 0 0 1 100 50');
    expect(error).toBeNull();
    const p = paths[0];
    expect(p.v[p.v.length - 1]).toEqual([100, 50]);
    expect(p.v.length).toBe(3); // half circle → 2 quarter segments
    // midpoint of the half circle sits at the top (y = 0)
    expect(p.v[1][0]).toBeCloseTo(50);
    expect(p.v[1][1]).toBeCloseTo(0);
  });

  it('returns partial results and an error on malformed input instead of throwing', () => {
    const r = parseSvgPath('M 0 0 L 10 # 5');
    expect(r.error).toMatch(/Expected number|Unexpected/);
    expect(r.paths.length).toBeGreaterThanOrEqual(0);
    expect(parseSvgPath('L 1 1').paths[0].v[0]).toEqual([0, 0]);
    expect(parseSvgPath('').paths).toEqual([]);
    expect(parseSvgPath('12').error).toMatch(/must start with a command/);
  });

  it('rounds coordinates and normalises negative zero', () => {
    const [p] = roundPaths(parseSvgPath('M 0.12345 -0.0001 L 1 1').paths);
    expect(p.v[0]).toEqual([0.123, 0]);
    expect(Object.is(p.v[0][1], -0)).toBe(false);
  });
});

describe('geometry', () => {
  it('builds a 4-vertex ellipse with kappa tangents', () => {
    const e = ellipseToPath(100, 50);
    expect(e.v).toEqual([
      [50, 0],
      [100, 25],
      [50, 50],
      [0, 25],
    ]);
    expect(e.o[0][0]).toBeCloseTo(50 * KAPPA);
  });

  it('clamps rect radius and produces sharp rects without tangents', () => {
    expect(rectToPath(10, 10, 0).v).toHaveLength(4);
    const r = rectToPath(10, 4, 100);
    expect(r.v).toHaveLength(8);
    expect(r.v[0]).toEqual([2, 0]);
  });

  it('normalises geometry to paths', () => {
    expect(geometryToPath({ type: 'ellipse', w: 2, h: 2 }).paths).toHaveLength(1);
    const path = { type: 'path' as const, paths: [], rule: 'evenodd' as const };
    expect(geometryToPath(path)).toBe(path);
  });
});
