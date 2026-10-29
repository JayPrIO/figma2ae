/**
 * Content-addressed on-disk asset cache: <root>/<hh>/<hash>.<ext>.
 *  - Hashes are validated against a strict regex before touching the filesystem (no traversal).
 *  - Writes are atomic (tmp file + rename) so a crash never leaves a truncated asset.
 *  - 40-char hashes are verified as SHA-1 of the bytes (Figma image hashes are SHA-1).
 *  - In-memory index makes `has` O(1); pruning evicts least-recently-used files past a budget.
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isValidHash } from '@f2ae/shared/protocol';

const EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' };

export interface StoredAsset {
  hash: string;
  path: string;
  bytes: number;
}

export class AssetIntegrityError extends Error {}

export class AssetStore {
  private readonly index = new Map<string, StoredAsset>();
  private ready: Promise<void> | null = null;

  constructor(
    readonly root: string,
    private readonly maxBytes = 2 * 1024 * 1024 * 1024,
  ) {}

  /** Loads the index from disk (idempotent). */
  init(): Promise<void> {
    if (!this.ready) this.ready = this.scan();
    return this.ready;
  }

  private async scan(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const shards = await readdir(this.root).catch(() => [] as string[]);
    for (const shard of shards) {
      if (!/^[a-f0-9]{2}$/.test(shard)) continue;
      const dir = join(this.root, shard);
      const files = await readdir(dir).catch(() => [] as string[]);
      for (const f of files) {
        const dot = f.indexOf('.');
        const hash = dot > 0 ? f.slice(0, dot) : f;
        if (!isValidHash(hash) || f.endsWith('.tmp')) continue;
        const p = join(dir, f);
        const s = await stat(p).catch(() => null);
        if (s && s.isFile()) this.index.set(hash, { hash, path: p, bytes: s.size });
      }
    }
  }

  has(hash: string): boolean {
    return this.index.has(hash);
  }

  get(hash: string): StoredAsset | undefined {
    return this.index.get(hash);
  }

  /** Returns the hashes from `hashes` that are not cached yet. */
  missing(hashes: readonly string[]): string[] {
    const out: string[] = [];
    for (const h of hashes) if (!this.index.has(h)) out.push(h);
    return out;
  }

  async put(hash: string, mime: string, bytes: Uint8Array): Promise<StoredAsset> {
    if (!isValidHash(hash)) throw new AssetIntegrityError(`invalid asset hash`);
    if (hash.length === 40) {
      const actual = createHash('sha1').update(bytes).digest('hex');
      if (actual !== hash) throw new AssetIntegrityError(`asset ${hash} failed SHA-1 verification`);
    }
    const existing = this.index.get(hash);
    if (existing) return existing;
    const dir = join(this.root, hash.slice(0, 2));
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${hash}.${EXT[mime] ?? 'png'}`);
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, path);
    const rec = { hash, path, bytes: bytes.byteLength };
    this.index.set(hash, rec);
    return rec;
  }

  /** Marks assets as recently used (protects them from pruning). */
  async touch(hashes: readonly string[]): Promise<void> {
    const now = new Date();
    await Promise.all(
      hashes.map((h) => {
        const a = this.index.get(h);
        return a ? utimes(a.path, now, now).catch(() => undefined) : undefined;
      }),
    );
  }

  /** Evicts least-recently-modified assets until the cache fits the byte budget. O(n log n). */
  async prune(): Promise<{ removed: number; bytes: number }> {
    let total = 0;
    for (const a of this.index.values()) total += a.bytes;
    if (total <= this.maxBytes) return { removed: 0, bytes: total };
    const withTime = await Promise.all(
      [...this.index.values()].map(async (a) => ({ a, t: (await stat(a.path).catch(() => null))?.mtimeMs ?? 0 })),
    );
    withTime.sort((x, y) => x.t - y.t);
    let removed = 0;
    for (const { a } of withTime) {
      if (total <= this.maxBytes) break;
      await unlink(a.path).catch(() => undefined);
      this.index.delete(a.hash);
      total -= a.bytes;
      removed++;
    }
    return { removed, bytes: total };
  }
}
