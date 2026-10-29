/** Parses an offline `.f2ae.json` bundle exported by the Figma plugin. */
import { createHash } from 'node:crypto';
import type { F2AEDocument } from '@f2ae/shared/schema';
import { isValidHash } from '@f2ae/shared/protocol';

export interface ParsedBundle {
  document: F2AEDocument;
  assets: { hash: string; mime: string; bytes: Uint8Array }[];
}

export function parseBundle(text: string): ParsedBundle {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('Not a Figma2AE bundle (invalid JSON)');
  }
  const b = raw as { format?: string; version?: number; document?: F2AEDocument; assets?: Record<string, { mime: string; base64: string }> };
  if (b.format !== 'f2ae-bundle' || b.version !== 1 || !b.document) throw new Error('Not a Figma2AE bundle');
  const assets: ParsedBundle['assets'] = [];
  for (const [hash, a] of Object.entries(b.assets ?? {})) {
    if (!isValidHash(hash)) throw new Error(`bundle contains an invalid asset id`);
    const bytes = new Uint8Array(Buffer.from(a.base64, 'base64'));
    if (hash.length === 40 && createHash('sha1').update(bytes).digest('hex') !== hash) throw new Error(`bundle asset ${hash.slice(0, 8)} is corrupted`);
    assets.push({ hash, mime: a.mime, bytes });
  }
  return { document: b.document, assets };
}
