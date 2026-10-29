/**
 * TypeScript → ES3 ExtendScript pipeline.
 *   1. esbuild: bundle src/jsx/main.ts (+ shared math) into one ES2015 IIFE
 *   2. Babel:   lower to ES5 (loose, no iterator/Symbol helpers) + ES3 property-name plugins
 *   3. Gate:    acorn must parse the output as ECMAScript 3, and no ES5+ runtime API may appear
 * Exported for the build script and the test suite.
 */
import { build } from 'esbuild';
import { transformAsync } from '@babel/core';
import * as acorn from 'acorn';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Runtime APIs that do not exist in ExtendScript (ES3) and must never be emitted. */
export const FORBIDDEN = [
  /\.forEach\(/,
  /\.map\(/,
  /\.filter\(/,
  /\.reduce\(/,
  /\.some\(/,
  /\.every\(/,
  /\.find\(/,
  /\.findIndex\(/,
  /\.includes\(/,
  /\.trim\(/,
  /\.startsWith\(/,
  /\.endsWith\(/,
  /\bObject\.(keys|assign|create|defineProperty|defineProperties|freeze|entries|values|getPrototypeOf)\b/,
  /\bArray\.(isArray|from|of)\b/,
  /\bDate\.now\b/,
  /\bMath\.(hypot|sign|trunc|log10|log2|cbrt)\b/,
  /\bNumber\.(isFinite|isNaN|isInteger|EPSILON)\b/,
  /\bSymbol\b/,
  /\bPromise\b/,
  /\bnew (Map|Set|WeakMap|WeakSet)\b/,
  /\bReflect\./,
];

/** ES3 reserved words: illegal as bare property names (`o.default`, `{ class: 1 }`) in ES3 engines. */
const RESERVED = 'break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with abstract boolean byte char double final float goto implements int interface long native package private protected public short static synchronized throws transient volatile'.split(' ');
const RESERVED_MEMBER = new RegExp(`\\.\\s*(${RESERVED.join('|')})\\b`);
const RESERVED_KEY = new RegExp(`[{,]\\s*(${RESERVED.join('|')})\\s*:`);

const HEADER = `/* Figma2AE ExtendScript builder - generated, do not edit. ES3 target. */\n`;

export async function buildJsx({ outfile = join(here, 'dist', 'jsx', 'f2ae.jsx'), minify = false } = {}) {
  const bundled = await build({
    entryPoints: [join(here, 'src', 'jsx', 'main.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    target: 'es2015',
    platform: 'neutral',
    charset: 'ascii', // ExtendScript files are safest as pure ASCII (\u escapes for the rest)
    legalComments: 'none',
    logLevel: 'silent',
  });
  const es2015 = bundled.outputFiles[0].text;

  const res = await transformAsync(es2015, {
    babelrc: false,
    configFile: false,
    compact: minify,
    // comments may carry non-ASCII; strings keep \u escapes so the file stays pure ASCII
    comments: false,
    generatorOpts: { jsescOption: { minimal: false } },
    sourceType: 'script',
    assumptions: {
      iterableIsArray: true,
      arrayLikeIsIterable: false,
      setSpreadProperties: true,
      ignoreToPrimitiveHint: true,
      noDocumentAll: true,
      mutableTemplateObject: true,
      setClassMethods: true,
      constantSuper: true,
      noClassCalls: true,
      superIsCallableConstructor: true,
      setPublicClassFields: true,
      privateFieldsAsProperties: true,
      pureGetters: true,
      skipForOfIteratorClosing: true,
    },
    presets: [
      [
        '@babel/preset-env',
        {
          targets: { ie: '9' },
          loose: true,
          modules: false,
          bugfixes: false,
          exclude: ['transform-typeof-symbol', 'transform-regenerator', 'transform-async-to-generator'],
        },
      ],
    ],
    plugins: [
      '@babel/plugin-transform-member-expression-literals',
      '@babel/plugin-transform-property-literals',
      '@babel/plugin-transform-reserved-words',
    ],
  });
  // ExtendScript runs sloppy-mode; drop the directive so tests and AE share semantics
  let code = HEADER + res.code.replace(/^\s*"use strict";\s*/, '') + '\n';
  const fixed = parenthesizeNestedTernaries(code);
  verifyEs3(fixed);
  code = fixed;
  await mkdir(dirname(outfile), { recursive: true });
  await writeFile(outfile, code, 'utf8');
  return { outfile, code, bytes: Buffer.byteLength(code) };
}

/** Minimal recursive AST visitor (avoids an acorn-walk dependency). */
function visit(node, fn) {
  if (!node || typeof node.type !== 'string') return;
  fn(node);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) for (const c of v) visit(c, fn);
    else if (v && typeof v.type === 'string') visit(v, fn);
  }
}

/** Nested conditional expressions in the consequent/alternate of another conditional. */
function nestedTernaries(code) {
  const ast = acorn.parse(code, { ecmaVersion: 3, sourceType: 'script' });
  const out = [];
  visit(ast, (n) => {
    if (n.type !== 'ConditionalExpression') return;
    for (const child of [n.consequent, n.alternate]) if (child.type === 'ConditionalExpression') out.push(child);
  });
  return out;
}

/**
 * ExtendScript's parser rejects `a ? b ? c : d : e` ("Expected: :") although it is valid ES3,
 * and Babel's printer drops the parentheses we write in source. Re-insert them on the output.
 */
export function parenthesizeNestedTernaries(code) {
  const nodes = nestedTernaries(code);
  const edits = [];
  for (const n of nodes) {
    edits.push({ at: n.start, text: '(' });
    edits.push({ at: n.end, text: ')' });
  }
  edits.sort((a, b) => b.at - a.at || (a.text === '(' ? 1 : -1));
  let out = code;
  for (const e of edits) out = out.slice(0, e.at) + e.text + out.slice(e.at);
  return out;
}

/** Throws with a precise location when the output is not valid ES3 or uses ES5+ APIs. */
export function verifyEs3(code) {
  try {
    acorn.parse(code, { ecmaVersion: 3, sourceType: 'script', allowReserved: false });
  } catch (e) {
    const lines = code.split('\n');
    const at = e.loc ? `\n> ${lines[e.loc.line - 1]}` : '';
    throw new Error(`ES3 gate: ${e.message}${at}`);
  }
  // ExtendScript parser quirk: nested ternaries must be explicitly parenthesised
  for (const n of nestedTernaries(code)) {
    if (code[n.start - 1] !== '(' || code[n.end] !== ')') {
      throw new Error(`ES3 gate: unparenthesised nested ternary (ExtendScript cannot parse it) near: …${code.slice(Math.max(0, n.start - 40), n.end + 10)}…`);
    }
  }
  // scan code only (strip comments + string literals) for forbidden runtime APIs
  const stripped = code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g, '""');
  for (const re of [RESERVED_MEMBER, RESERVED_KEY]) {
    const m = re.exec(stripped);
    if (m) throw new Error(`ES3 gate: reserved word "${m[1]}" used as a property name near: …${stripped.slice(Math.max(0, m.index - 40), m.index + 40)}…`);
  }
  for (const re of FORBIDDEN) {
    const m = re.exec(stripped);
    if (m) {
      const idx = m.index;
      const ctx = stripped.slice(Math.max(0, idx - 60), idx + 60).replace(/\s+/g, ' ');
      throw new Error(`ES3 gate: forbidden API ${re} near: …${ctx}…`);
    }
  }
  const nonAscii = /[^\x00-\x7f]/.exec(code);
  if (nonAscii) throw new Error(`ES3 gate: output must be ASCII, found U+${nonAscii[0].charCodeAt(0).toString(16)} near: ${code.slice(Math.max(0, nonAscii.index - 60), nonAscii.index + 20)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const r = await buildJsx();
  console.log(`f2ae.jsx → ${r.outfile} (${(r.bytes / 1024).toFixed(1)} KiB, ES3 verified)`);
}
