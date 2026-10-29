#!/usr/bin/env node
/**
 * Builds every part of the monorepo into ./dist and prints local install instructions.
 *
 *   dist/figma-plugin/            manifest.json, code.js, ui.html
 *   dist/ae-extension/io.jaypr.figma2ae/   CEP panel + ExtendScript builder
 *   dist/bridge-cli/cli.js        standalone dev bridge (no After Effects needed)
 *
 * Flags: --dev (unminified, CEP remote debugging enabled), --quiet
 */
import { spawn } from 'node:child_process';
import { cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));
const dev = process.argv.includes('--dev');
const quiet = process.argv.includes('--quiet');
const dist = join(root, 'dist');
const EXT_ID = 'io.jaypr.figma2ae';

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, stdio: quiet ? 'ignore' : 'inherit' });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} failed in ${cwd} (exit ${code})`))));
  });
}

const t0 = Date.now();
const step = (s) => !quiet && console.log(`\n▸ ${s}`);

step('Source checks');
await run(process.execPath, [join(root, 'scripts', 'check-sources.mjs')], root);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

step('Bridge CLI');
await run(process.execPath, ['build.mjs'], join(root, 'bridge-server'));
await mkdir(join(dist, 'bridge-cli'), { recursive: true });
await cp(join(root, 'bridge-server', 'dist', 'cli.js'), join(dist, 'bridge-cli', 'cli.js'));

step('Figma plugin');
await run(process.execPath, ['build.mjs'], join(root, 'figma-plugin'));
await cp(join(root, 'figma-plugin', 'dist'), join(dist, 'figma-plugin'), { recursive: true });

step('After Effects extension (panel + ES3 builder)');
await run(process.execPath, ['build.mjs', ...(dev ? ['--dev'] : [])], join(root, 'ae-extension'));
await cp(join(root, 'ae-extension', 'dist', EXT_ID), join(dist, 'ae-extension', EXT_ID), { recursive: true });
await cp(join(root, 'scripts', 'install-ae-extension.sh'), join(dist, 'ae-extension', 'install.sh'));

const cepDir = join(homedir(), 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions');
console.log(`
✔ Built in ${((Date.now() - t0) / 1000).toFixed(1)}s → ${dist}

────────────────────────────── Local testing ──────────────────────────────
 FIGMA (desktop app)
   1. Figma ▸ Plugins ▸ Development ▸ Import plugin from manifest…
   2. Choose: ${join(dist, 'figma-plugin', 'manifest.json')}
   3. Run:    Plugins ▸ Development ▸ Figma2AE

 AFTER EFFECTS (2023 or newer)
   1. make install-ae        (or: sh "${join(dist, 'ae-extension', 'install.sh')}")
      → copies ${EXT_ID} into:
        ${cepDir}
      → enables PlayerDebugMode (needed for unsigned CEP extensions)
   2. Restart After Effects ▸ Window ▸ Extensions ▸ Figma2AE
   3. The panel shows "Listening on :7741". Keep it open (docking it is fine).

 NO AFTER EFFECTS? Run the dev bridge and sync from Figma:
      make dev-bridge          (writes received documents to ./received)
${dev ? `\n Remote DevTools for the panel: http://localhost:8092 (dev build)\n` : ''}───────────────────────────────────────────────────────────────────────────`);
