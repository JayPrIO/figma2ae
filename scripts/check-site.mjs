#!/usr/bin/env node
/**
 * Static checks for the GitHub Pages site (site/): every local href/src resolves to a file and
 * every same-page or cross-page #anchor exists. Runs in CI before deploying.
 */
import { readdir, readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const site = fileURLToPath(new URL('../site/', import.meta.url));
const pages = (await readdir(site)).filter((f) => f.endsWith('.html'));
const ids = new Map();
const html = new Map();
for (const p of pages) {
  const text = await readFile(join(site, p), 'utf8');
  html.set(p, text);
  ids.set(p, new Set([...text.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
}

const problems = [];
for (const [page, text] of html) {
  if (page === '404.html') continue; // uses absolute /figma2ae/ paths for nested 404s
  for (const m of text.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
    const url = m[1];
    if (/^(https?:|mailto:|data:)/.test(url)) continue;
    const [path, hash] = url.split('#');
    const target = path === '' || path === './' ? (path === '' ? page : 'index.html') : path;
    try {
      await access(join(site, dirname(page), target));
    } catch {
      problems.push(`${page}: broken link ${url}`);
      continue;
    }
    if (hash && target.endsWith('.html') && !ids.get(target)?.has(hash)) problems.push(`${page}: missing anchor ${url}`);
  }
}
if (problems.length) {
  console.error(`✖ site checks failed:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
console.log(`✔ site checks passed (${pages.length} pages)`);
