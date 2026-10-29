import { bench, describe } from 'vitest';
import { parseSvgPath } from '../src/svg-path';
import { decompose, invert, multiply } from '../src/matrix';
import type { Mat2x3 } from '../src/schema';

// ~10k-segment path, representative of a dense icon set / illustration.
const segments: string[] = ['M 0 0'];
for (let i = 0; i < 10_000; i++) {
  segments.push(i % 2 ? `L ${i} ${i % 37}` : `C ${i} 1.5 ${i + 0.5} 2.25 ${i + 1} -3.125`);
}
segments.push('Z');
const bigPath = segments.join(' ');

describe('svg-path', () => {
  bench(`parseSvgPath ${(bigPath.length / 1024).toFixed(0)} KiB`, () => {
    parseSvgPath(bigPath);
  });
});

describe('matrix', () => {
  const a: Mat2x3 = [0.7, -1.2, 2.3, 0.4, 100, 50];
  const b: Mat2x3 = [1.1, 0.2, -0.3, 0.9, -4, 8];
  bench('multiply + invert + decompose', () => {
    decompose(multiply(invert(a), b));
  });
});
