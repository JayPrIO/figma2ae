import { describe, expect, it } from 'vitest';
import {
  decodeAssetFrame,
  encodeAssetFrame,
  isAllowedOrigin,
  isValidHash,
  newSyncId,
  parseClientMessage,
  isValidSyncId,
} from '../src/protocol';
import { validateDocument } from '../src/validate';
import type { F2AEDocument, SceneNode } from '../src/schema';
import { DEFAULT_BUILD_OPTIONS } from '../src/schema';

describe('protocol', () => {
  it('round-trips asset frames', () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const frame = encodeAssetFrame({ syncId: 'abcd1234', hash: 'deadbeef', mime: 'image/png' }, bytes);
    const r = decodeAssetFrame(frame);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.header.hash).toBe('deadbeef');
      expect(Array.from(r.value.bytes)).toEqual([1, 2, 3, 250]);
    }
  });

  it('decodes frames that are views into a larger buffer', () => {
    const frame = encodeAssetFrame({ syncId: 'abcd1234', hash: 'deadbeef', mime: 'image/png' }, new Uint8Array([9]));
    const big = new Uint8Array(frame.length + 10);
    big.set(frame, 10);
    const r = decodeAssetFrame(big.subarray(10));
    expect(r.ok && Array.from(r.value.bytes)).toEqual([9]);
  });

  it('rejects malformed asset frames', () => {
    expect(decodeAssetFrame(new Uint8Array([0, 0])).ok).toBe(false);
    expect(decodeAssetFrame(new Uint8Array([0, 0, 0, 99, 1])).ok).toBe(false);
    const evil = encodeAssetFrame({ syncId: 'abcd1234', hash: '../../etc/passwd', mime: 'x' }, new Uint8Array(1));
    expect(decodeAssetFrame(evil).ok).toBe(false);
  });

  it('validates hashes, sync ids and origins', () => {
    expect(isValidHash('0123abcd')).toBe(true);
    expect(isValidHash('../x')).toBe(false);
    expect(isValidHash('ABCDEF12')).toBe(false);
    expect(isValidSyncId(newSyncId())).toBe(true);
    expect(isAllowedOrigin('null')).toBe(true);
    expect(isAllowedOrigin(undefined)).toBe(true);
    expect(isAllowedOrigin('https://www.figma.com')).toBe(true);
    expect(isAllowedOrigin('https://evil.example')).toBe(false);
  });

  it('parses client messages defensively', () => {
    expect(parseClientMessage('nope').ok).toBe(false);
    expect(parseClientMessage('null').ok).toBe(false);
    expect(parseClientMessage('{"type":"x"}').ok).toBe(false);
    expect(parseClientMessage('{"type":"hello","protocol":1,"clientVersion":"1"}').ok).toBe(true);
    expect(parseClientMessage('{"type":"sync.begin","syncId":"abcd1234","assets":[{"hash":"zz","byteLength":1}]}').ok).toBe(false);
    expect(parseClientMessage('{"type":"sync.begin","syncId":"abcd1234","assets":[{"hash":"abcdef12","byteLength":1}]}').ok).toBe(true);
    expect(parseClientMessage('{"type":"sync.commit","syncId":"abcd1234"}').ok).toBe(false);
  });
});

function shape(): SceneNode {
  return {
    kind: 'shape',
    id: '1',
    name: 'r',
    figmaType: 'RECTANGLE',
    visible: true,
    opacity: 1,
    blendMode: 'normal',
    size: { w: 10, h: 10 },
    transform: [1, 0, 0, 1, 0, 0],
    effects: [],
    isMask: false,
    maskType: 'alpha',
    geometry: { type: 'rect', w: 10, h: 10, radius: 0 },
    fills: [],
    stroke: null,
  };
}

export function makeDoc(nodes: SceneNode[]): F2AEDocument {
  return {
    schemaVersion: 1,
    generator: { name: 't', version: '0' },
    createdAt: 0,
    source: { fileName: 'f', pageName: 'p' },
    options: DEFAULT_BUILD_OPTIONS,
    roots: nodes.map((node) => ({ node, size: { w: 10, h: 10 }, canvasOrigin: [0, 0] as [number, number] })),
    assets: [],
    fonts: [],
    warnings: [],
  };
}

describe('validateDocument', () => {
  it('accepts a well-formed document', () => {
    const r = validateDocument(makeDoc([shape()]));
    expect(r).toEqual({ ok: true, errors: [], nodeCount: 1 });
  });

  it('rejects bad structure with useful paths', () => {
    const bad = shape() as unknown as Record<string, unknown>;
    bad.transform = [1, 2];
    const r = validateDocument(makeDoc([bad as unknown as SceneNode]));
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('roots[0]: transform invalid');
    expect(validateDocument(null).ok).toBe(false);
    expect(validateDocument({ schemaVersion: 2, roots: [], assets: [], options: {} }).ok).toBe(false);
  });

  it('handles very deep nesting without recursion', () => {
    let node: SceneNode = shape();
    for (let i = 0; i < 5000; i++) {
      node = { ...shape(), kind: 'container', clips: false, geometry: null, children: [node] } as SceneNode;
    }
    const r = validateDocument(makeDoc([node]));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('nesting deeper'))).toBe(true);
  });
});
