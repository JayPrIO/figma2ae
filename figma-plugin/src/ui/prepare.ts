/**
 * Turns an extraction result into a wire-ready payload: content-hash every asset (SHA-1,
 * verified by the bridge), dedupe identical bytes, and rewrite provisional document keys.
 * Also builds the offline `.f2ae.json` bundle used when After Effects isn't reachable.
 */
import type { F2AEDocument } from '@f2ae/shared/schema';
import type { ExtractedAsset } from '../main/extract';
import { rewriteAssetKeys } from '../main/extract';
import type { SyncAsset } from './transport';

export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes as unknown as ArrayBuffer);
  const v = new Uint8Array(digest);
  let s = '';
  for (let i = 0; i < v.length; i++) s += (v[i] < 16 ? '0' : '') + v[i].toString(16);
  return s;
}

export async function preparePayload(document: F2AEDocument, extracted: ExtractedAsset[]): Promise<{ document: F2AEDocument; assets: SyncAsset[] }> {
  const map = new Map<string, string>();
  const unique = new Map<string, SyncAsset>();
  const hashes = await Promise.all(extracted.map((a) => sha1Hex(a.bytes)));
  extracted.forEach((a, i) => {
    map.set(a.key, hashes[i]);
    if (!unique.has(hashes[i])) unique.set(hashes[i], { hash: hashes[i], mime: a.mime, bytes: a.bytes });
  });
  rewriteAssetKeys(document, map);
  // collapse duplicate asset entries after rewrite
  const seen = new Set<string>();
  document.assets = document.assets.filter((a) => (seen.has(a.hash) ? false : (seen.add(a.hash), true)));
  return { document, assets: [...unique.values()] };
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

export const BUNDLE_FORMAT = 'f2ae-bundle';

/** Offline bundle: document + base64 assets. Imported by the AE panel ("Import .f2ae.json"). */
export function makeBundle(document: F2AEDocument, assets: SyncAsset[]): string {
  const data: Record<string, { mime: string; base64: string }> = {};
  for (const a of assets) data[a.hash] = { mime: a.mime, base64: toBase64(a.bytes) };
  return JSON.stringify({ format: BUNDLE_FORMAT, version: 1, document, assets: data });
}
