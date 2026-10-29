#!/usr/bin/env node
/**
 * Pre-build guards:
 *  1. No raw U+2028/U+2029 in sources (they terminate lines in JS/ES3 string literals and
 *     regexes; always write them as \u2028 / \u2029 escapes).
 *  2. Version consistency: every package.json, the Figma/CEP manifests and PRODUCT_VERSION agree.
 *  3. Optional: `--tag vX.Y.Z` must match that version (used by the release workflow).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const problems = [];

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'dist' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mjs|js|json|html|css)$/.test(e.name)) yield p;
  }
}

for await (const file of walk(root)) {
  const text = await readFile(file, 'utf8');
  const i = text.search(/[\u2028\u2029]/);
  if (i !== -1) {
    const line = text.slice(0, i).split('\n').length;
    problems.push(`${relative(root, file)}:${line}: raw U+${text.charCodeAt(i).toString(16).toUpperCase()} — write it as an escape`);
  }
}

const read = async (p) => readFile(join(root, p), 'utf8');
const version = /PRODUCT_VERSION = '([^']+)'/.exec(await read('shared/src/version.ts'))[1];
const versions = {
  'shared/src/version.ts': version,
  'package.json': JSON.parse(await read('package.json')).version,
};
for (const ws of ['shared', 'bridge-server', 'figma-plugin', 'ae-extension']) versions[`${ws}/package.json`] = JSON.parse(await read(`${ws}/package.json`)).version;
const cep = await read('ae-extension/cep/CSXS/manifest.xml');
versions['CSXS/manifest.xml (bundle)'] = /ExtensionBundleVersion="([^"]+)"/.exec(cep)[1];
versions['CSXS/manifest.xml (extension)'] = /<Extension Id="[^"]+" Version="([^"]+)"/.exec(cep)[1];
for (const [where, v] of Object.entries(versions)) if (v !== version) problems.push(`${where}: version ${v} ≠ ${version}`);

const tagIdx = process.argv.indexOf('--tag');
if (tagIdx !== -1) {
  const tag = process.argv[tagIdx + 1] ?? '';
  if (tag.replace(/^v/, '') !== version) problems.push(`git tag ${tag} does not match version ${version}`);
}

if (problems.length) {
  console.error(`✖ source checks failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`✔ source checks passed (version ${version})`);
