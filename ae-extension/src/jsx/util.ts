/**
 * ES3-safe utilities for the ExtendScript builder.
 *
 * HARD RULES for every file under src/jsx (enforced by the build's ES3 gate):
 *  - no Array.prototype.{indexOf,forEach,map,filter,reduce,some,every,find,includes}
 *  - no Object.keys / Object.assign / Object.create / Object.defineProperty / JSON.* (use helpers)
 *  - no classes, getters/setters, spread, destructuring of iterables, for-of, Symbol, Map/Set, Promise
 *  - no Date.now (use nowMs), no String.prototype.trim
 *  - never extend built-in prototypes (the AE scripting engine is shared with other extensions)
 */

export function nowMs(): number {
  return new Date().getTime();
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function round(x: number, digits: number): number {
  var f = Math.pow(10, digits);
  return Math.round(x * f) / f;
}

export function hasOwn(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

export function contains<T>(arr: T[], v: T): boolean {
  for (var i = 0; i < arr.length; i++) if (arr[i] === v) return true;
  return false;
}

/** Collects user-facing warnings, de-duplicated, capped. */
export interface Warnings {
  list: string[];
  seen: { [k: string]: boolean };
}

export function newWarnings(): Warnings {
  return { list: [], seen: {} };
}

export function warn(w: Warnings, msg: string): void {
  if (w.seen[msg] || w.list.length >= 300) return;
  w.seen[msg] = true;
  w.list.push(msg);
}

// ─────────────────────────────── JSON ────────────────────────────────

/**
 * Parses JSON produced by the panel. The panel serialises with JSON.stringify and escapes
 * U+2028/U+2029, so the text is a strict JSON subset of ES3 expression syntax; eval is used
 * because a hand-written parser is ~50× slower in ExtendScript on multi-MB documents.
 * Defence in depth: reject anything that is not shaped like a JSON object/array.
 */
export function parseJson(text: string): any {
  var g: any = $.global;
  if (g.JSON && typeof g.JSON.parse === 'function') return g.JSON.parse(text);
  var first = text.charAt(0);
  if (first !== '{' && first !== '[') throw new Error('job file is not JSON');
  // json2-style safety check on a bounded prefix keeps cost O(1) for large payloads
  // (the whole file was produced by our own serializer; this guards against foreign files).
  if (/\b(function|new|this|while|for|var)\b\s*[\(\{]/.test(text.substring(0, 2048))) throw new Error('job file is not JSON');
  return eval('(' + text + ')');
}

function quote(s: string): string {
  var out = '"';
  for (var i = 0; i < s.length; i++) {
    var c = s.charAt(i);
    var code = s.charCodeAt(i);
    if (c === '"' || c === '\\') out += '\\' + c;
    else if (c === '\n') out += '\\n';
    else if (c === '\r') out += '\\r';
    else if (c === '\t') out += '\\t';
    else if (code < 32 || code === 0x2028 || code === 0x2029) {
      var hex = code.toString(16);
      while (hex.length < 4) hex = '0' + hex;
      out += '\\u' + hex;
    } else out += c;
  }
  return out + '"';
}

/** Minimal JSON.stringify for plain data (results only). */
export function stringify(v: any): string {
  if (v === null || v === undefined) return 'null';
  var t = typeof v;
  if (t === 'number') return isFinite(v) ? String(v) : 'null';
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'string') return quote(v);
  if (v instanceof Array) {
    var parts: string[] = [];
    for (var i = 0; i < v.length; i++) parts.push(stringify(v[i]));
    return '[' + parts.join(',') + ']';
  }
  var items: string[] = [];
  for (var k in v) {
    if (!hasOwn(v, k) || v[k] === undefined || typeof v[k] === 'function') continue;
    items.push(quote(k) + ':' + stringify(v[k]));
  }
  return '{' + items.join(',') + '}';
}

// ─────────────────────────────── files ───────────────────────────────

export function readTextFile(path: string): string {
  var f = new File(path);
  if (!f.exists) throw new Error('file not found: ' + path);
  f.encoding = 'UTF-8';
  if (!f.open('r')) throw new Error('cannot open: ' + path);
  try {
    return f.read();
  } finally {
    f.close();
  }
}

export function writeTextFile(path: string, text: string): void {
  var f = new File(path);
  f.encoding = 'UTF-8';
  if (!f.open('w')) throw new Error('cannot write: ' + path);
  try {
    f.write(text);
  } finally {
    f.close();
  }
}
