import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportNodes, exportSettings } from '../src/main/export-files';
import { crc32, uniqueNames, zip } from '../src/ui/zip';

describe('file export', () => {
  it('uses Figma export settings per format and clamps PNG scale', () => {
    expect(exportSettings('PNG', 9)).toEqual({ format: 'PNG', constraint: { type: 'SCALE', value: 4 } });
    expect(exportSettings('SVG', 1)).toMatchObject({ format: 'SVG', svgOutlineText: true });
    expect(exportSettings('PDF', 1)).toEqual({ format: 'PDF' });
  });

  it('exports every selected node with the requested settings', async () => {
    const seen: unknown[] = [];
    const node = (name: string) => ({ name, exportAsync: async (s: Record<string, unknown>) => (seen.push(s), new TextEncoder().encode(`<svg id="${name}"/>`)) });
    const files = await exportNodes([node('A'), node('B')], 'SVG', 1);
    expect(files.map((f) => f.name)).toEqual(['A', 'B']);
    expect(new TextDecoder().decode(files[1].bytes)).toBe('<svg id="B"/>');
    expect(seen).toHaveLength(2);
  });

  it('makes unique, filesystem-safe names', () => {
    expect(uniqueNames(['Button', 'button', 'a/b:c', '', 'Button'], 'png')).toEqual(['Button.png', 'button 2.png', 'a_b_c.png', 'layer.png', 'Button 3.png']);
  });

  it('computes standard CRC-32', () => {
    expect(crc32(new TextEncoder().encode('123456789')).toString(16)).toBe('cbf43926');
  });

  it('writes zips that the system unzip extracts byte-for-byte', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'f2ae-zip-'));
    try {
      const png = new Uint8Array(5000).map((_, i) => (i * 31) % 256);
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>');
      await writeFile(join(dir, 'out.zip'), zip([
        { name: 'Button.png', data: png },
        { name: 'Icon.svg', data: svg },
      ]));
      // UTF-8 name flag (bit 11) is set so non-ASCII layer names survive
      expect(new DataView((await readFile(join(dir, 'out.zip'))).buffer).getUint16(6, true) & 0x0800).toBe(0x0800);
      const listing = execFileSync('unzip', ['-t', join(dir, 'out.zip')]).toString();
      expect(listing).toMatch(/No errors detected/);
      execFileSync('unzip', ['-q', join(dir, 'out.zip'), '-d', join(dir, 'x')]);
      expect(Buffer.compare(await readFile(join(dir, 'x', 'Button.png')), Buffer.from(png))).toBe(0);
      expect((await readFile(join(dir, 'x', 'Icon.svg'), 'utf8')).startsWith('<svg')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
