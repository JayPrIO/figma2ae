// Builds the CEP extension folder: dist/io.jaypr.figma2ae/{CSXS,index.html,panel.js,panel.css,jsx/f2ae.jsx}
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildJsx } from './build-jsx.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const dev = process.argv.includes('--dev');
export const EXTENSION_ID = 'io.jaypr.figma2ae';
const out = join(here, 'dist', EXTENSION_ID);

await rm(join(here, 'dist'), { recursive: true, force: true });
await mkdir(out, { recursive: true });

// CEP 11 (AE 2023) embeds Node 15.9, which cannot require('node:fs'): emit bare builtin names.
const stripNodePrefix = {
  name: 'strip-node-prefix',
  setup(b) {
    b.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path.slice(5), external: true }));
  },
};

// Panel: Node mixed context → `require` of builtins stays a runtime require.
await build({
  plugins: [stripNodePrefix],
  entryPoints: [join(here, 'src', 'panel', 'main.ts')],
  outfile: join(out, 'panel.js'),
  bundle: true,
  platform: 'node',
  format: 'iife',
  target: ['node15', 'chrome88'],
  external: ['bufferutil', 'utf-8-validate'],
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
  legalComments: 'none',
  logLevel: 'warning',
});

const jsx = await buildJsx({ outfile: join(out, 'jsx', 'f2ae.jsx') });
await cp(join(here, 'cep', 'CSXS'), join(out, 'CSXS'), { recursive: true });
await cp(join(here, 'cep', 'index.html'), join(out, 'index.html'));
await cp(join(here, 'cep', 'panel.css'), join(out, 'panel.css'));
if (dev) await cp(join(here, 'cep', '.debug'), join(out, '.debug'));
console.log(`ae-extension → ${out} (jsx ${(jsx.bytes / 1024).toFixed(1)} KiB, ES3 verified)`);
