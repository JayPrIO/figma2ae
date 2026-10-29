// Builds the Figma plugin into ./dist: code.js (main thread), ui.html (single file), manifest.json.
import { build as esbuild, context } from 'esbuild';
import { build as viteBuild } from 'vite';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

// figma-plugin/manifest.json points into dist/ so it can be imported straight from the source tree;
// the copy inside dist/ (what releases ship) points at its sibling files.
async function writeDistManifest() {
  const m = JSON.parse(await readFile('manifest.json', 'utf8'));
  m.main = 'code.js';
  m.ui = 'ui.html';
  await writeFile('dist/manifest.json', JSON.stringify(m, null, 2) + '\n');
}
await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

const mainOpts = {
  entryPoints: ['src/main/code.ts'],
  outfile: 'dist/code.js',
  bundle: true,
  format: 'iife',
  // Figma's main-thread sandbox: stay conservative on syntax.
  target: 'es2017',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
};

if (watch) {
  const ctx = await context(mainOpts);
  await ctx.watch();
  await writeDistManifest();
  await viteBuild({ configFile: 'vite.config.ts', build: { watch: {} } });
} else {
  await esbuild(mainOpts);
  await viteBuild({ configFile: 'vite.config.ts' });
  await writeDistManifest();
  console.log('figma-plugin → dist/{manifest.json,code.js,ui.html}');
}
