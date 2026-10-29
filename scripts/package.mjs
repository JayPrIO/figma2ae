#!/usr/bin/env node
/**
 * Packages ./dist into release zips (run `npm run build` first):
 *   dist/release/Figma2AE-figma-plugin-v<version>.zip
 *   dist/release/Figma2AE-ae-extension-v<version>.zip   (includes install.sh)
 *   dist/release/SHA256SUMS.txt
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = join(root, 'dist');
const out = join(dist, 'release');
const version = /PRODUCT_VERSION = '([^']+)'/.exec(await readFile(join(root, 'shared', 'src', 'version.ts'), 'utf8'))[1];

try {
  await access(join(dist, 'figma-plugin', 'manifest.json'));
  await access(join(dist, 'ae-extension', 'io.jaypr.figma2ae', 'CSXS', 'manifest.xml'));
} catch {
  console.error('✖ dist/ is incomplete — run `npm run build` first');
  process.exit(1);
}

function zip(cwd, archive, entries) {
  return new Promise((resolve, reject) => {
    // -X: no extra file attributes (reproducible), -r: recursive, -q: quiet
    const p = spawn('zip', ['-X', '-r', '-q', archive, ...entries], { cwd, stdio: 'inherit' });
    p.on('error', reject);
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`zip exited ${c}`))));
  });
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const README_FIGMA = `Figma2AE ${version} — Figma plugin

1. Unzip this folder somewhere permanent (e.g. ~/Applications/Figma2AE).
2. Figma desktop ▸ Plugins ▸ Development ▸ Import plugin from manifest…
3. Select figma-plugin/manifest.json
4. Run Plugins ▸ Development ▸ Figma2AE

The plugin talks only to the Figma2AE panel in After Effects on this computer (localhost:7741-7745).
`;
const README_AE = `Figma2AE ${version} — After Effects panel (AE 2023 or newer, macOS)

Install:   open Terminal in this folder and run:   sh install.sh
Uninstall: sh install.sh --uninstall

Then restart After Effects and open Window ▸ Extensions ▸ Figma2AE.
Logs: ~/Library/Logs/Figma2AE/bridge.log
`;

const stage = join(out, 'stage');
await mkdir(join(stage, 'figma'), { recursive: true });
await cp(join(dist, 'figma-plugin'), join(stage, 'figma', 'figma-plugin'), { recursive: true });
await writeFile(join(stage, 'figma', 'README.txt'), README_FIGMA);
await mkdir(join(stage, 'ae'), { recursive: true });
await cp(join(dist, 'ae-extension'), join(stage, 'ae'), { recursive: true });
await writeFile(join(stage, 'ae', 'README.txt'), README_AE);

// Stable names so https://github.com/<owner>/<repo>/releases/latest/download/<name> always works;
// the version lives in the release title, README.txt and SHA256SUMS.txt.
const figmaZip = `Figma2AE-figma-plugin.zip`;
const aeZip = `Figma2AE-ae-extension.zip`;
await zip(join(stage, 'figma'), join(out, figmaZip), ['.']);
await zip(join(stage, 'ae'), join(out, aeZip), ['.']);
await rm(stage, { recursive: true, force: true });

const sums = [];
for (const f of [figmaZip, aeZip]) {
  const h = createHash('sha256').update(await readFile(join(out, f))).digest('hex');
  sums.push(`${h}  ${f}`);
}
await writeFile(join(out, 'SHA256SUMS.txt'), sums.join('\n') + '\n');
console.log(`✔ Packaged v${version} → ${out}\n  ${sums.join('\n  ')}`);
