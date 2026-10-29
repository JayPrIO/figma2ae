/**
 * Runtime validation of an inbound F2AEDocument. Iterative (explicit stack) so deeply
 * nested documents cannot blow the call stack; O(nodes).
 */
import type { F2AEDocument, SceneNode } from './schema';
import { isValidHash, LIMITS } from './protocol';
import { SCHEMA_VERSION } from './version';

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  nodeCount: number;
}

const KINDS: Record<string, true> = { container: true, shape: true, text: true, raster: true };
const MAX_ERRORS = 20;

function isMat(m: unknown): boolean {
  if (!Array.isArray(m) || m.length !== 6) return false;
  for (let i = 0; i < 6; i++) if (typeof m[i] !== 'number' || !isFinite(m[i] as number)) return false;
  return true;
}

export function validateDocument(doc: unknown): ValidationResult {
  const errors: string[] = [];
  const err = (e: string): void => {
    if (errors.length < MAX_ERRORS) errors.push(e);
  };
  if (typeof doc !== 'object' || doc === null) return { ok: false, errors: ['document is not an object'], nodeCount: 0 };
  const d = doc as F2AEDocument;
  if (d.schemaVersion !== SCHEMA_VERSION) err(`unsupported schemaVersion ${String(d.schemaVersion)}`);
  if (typeof d.options !== 'object' || d.options === null) err('options missing');
  if (!Array.isArray(d.roots)) return { ok: false, errors: errors.concat('roots must be an array'), nodeCount: 0 };
  if (!Array.isArray(d.assets)) err('assets must be an array');
  else for (const a of d.assets) if (!isValidHash(a && a.hash)) err('asset hash invalid');

  let count = 0;
  const stack: { n: SceneNode; depth: number; path: string }[] = [];
  for (let r = 0; r < d.roots.length; r++) {
    const root = d.roots[r];
    if (!root || typeof root !== 'object' || !root.node) {
      err(`roots[${r}] missing node`);
      continue;
    }
    stack.push({ n: root.node, depth: 0, path: `roots[${r}]` });
  }
  while (stack.length > 0) {
    const { n, depth, path } = stack.pop()!;
    count++;
    if (count > LIMITS.maxNodes) {
      err(`document exceeds ${LIMITS.maxNodes} nodes`);
      break;
    }
    if (depth > LIMITS.maxDepth) {
      err(`${path}: nesting deeper than ${LIMITS.maxDepth}`);
      continue;
    }
    if (typeof n !== 'object' || n === null || !KINDS[(n as SceneNode).kind]) {
      err(`${path}: unknown node kind`);
      continue;
    }
    if (!isMat(n.transform)) err(`${path}: transform invalid`);
    if (!n.size || typeof n.size.w !== 'number' || typeof n.size.h !== 'number') err(`${path}: size invalid`);
    if (n.kind === 'container') {
      if (!Array.isArray(n.children)) {
        err(`${path}: children must be an array`);
        continue;
      }
      for (let i = 0; i < n.children.length; i++) stack.push({ n: n.children[i], depth: depth + 1, path: `${path}/${i}` });
    } else if (n.kind === 'text') {
      if (!n.text || typeof n.text.characters !== 'string' || !Array.isArray(n.text.segments)) err(`${path}: text invalid`);
    } else if (n.kind === 'raster') {
      if (typeof n.asset !== 'string') err(`${path}: raster asset invalid`);
    } else if (n.kind === 'shape') {
      if (!n.geometry || typeof n.geometry.type !== 'string') err(`${path}: geometry missing`);
    }
  }
  return { ok: errors.length === 0, errors, nodeCount: count };
}
