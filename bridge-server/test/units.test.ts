import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AssetIntegrityError, AssetStore } from '../src/asset-store';
import { JobTimeoutError, QueueFullError, SerialQueue } from '../src/build-queue';
import { createLogger } from '../src/logger';
import { Histogram } from '../src/metrics';

describe('Histogram', () => {
  it('estimates quantiles within bucket resolution', () => {
    const h = new Histogram('t', 't', [10, 20, 50, 100]);
    for (let i = 1; i <= 100; i++) h.observe(i);
    const s = h.snapshot();
    expect(s.count).toBe(100);
    expect(s.mean).toBeCloseTo(50.5);
    expect(s.p50).toBeGreaterThanOrEqual(20);
    expect(s.p50).toBeLessThanOrEqual(50);
    expect(s.p99).toBeGreaterThan(90);
    expect(s.p99).toBeLessThanOrEqual(100);
    expect(h.render()).toContain('t_bucket{le="+Inf"} 100');
  });

  it('is empty-safe', () => {
    expect(new Histogram('e', 'e').quantile(0.99)).toBe(0);
  });
});

describe('SerialQueue', () => {
  it('runs jobs strictly one at a time, in order', async () => {
    const q = new SerialQueue<number>(10, 1000);
    const order: number[] = [];
    let running = 0;
    const job = (n: number) => async () => {
      running++;
      expect(running).toBe(1);
      await new Promise((r) => setTimeout(r, 5));
      order.push(n);
      running--;
      return n;
    };
    const results = await Promise.all([1, 2, 3].map((n) => q.push(job(n)).result));
    expect(results).toEqual([1, 2, 3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('rejects when full and times out stuck jobs without blocking the queue', async () => {
    const q = new SerialQueue<number>(1, 30);
    const stuck = q.push(() => new Promise<number>(() => undefined));
    const next = q.push(async () => 7);
    expect(() => q.push(async () => 8)).toThrow(QueueFullError);
    await expect(stuck.result).rejects.toBeInstanceOf(JobTimeoutError);
    await expect(next.result).resolves.toBe(7);
  });

  it('survives many jobs (compaction path)', async () => {
    const q = new SerialQueue<number>(1000, 1000);
    const all = Array.from({ length: 500 }, (_, i) => q.push(async () => i).result);
    const r = await Promise.all(all);
    expect(r[499]).toBe(499);
    expect(q.depth).toBe(0);
  });
});

describe('AssetStore', () => {
  it('stores atomically, verifies SHA-1, reloads its index and prunes LRU', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'f2ae-assets-'));
    try {
      const s = new AssetStore(dir, 10);
      await s.init();
      const a = new Uint8Array([1, 2, 3, 4, 5, 6]);
      const b = new Uint8Array([9, 9, 9, 9, 9, 9]);
      const ha = createHash('sha1').update(a).digest('hex');
      const hb = createHash('sha1').update(b).digest('hex');
      await s.put(ha, 'image/png', a);
      await expect(s.put(hb, 'image/png', a)).rejects.toBeInstanceOf(AssetIntegrityError);
      await expect(s.put('../../x', 'image/png', a)).rejects.toBeInstanceOf(AssetIntegrityError);
      await s.put(hb, 'image/jpeg', b);
      expect(s.get(hb)!.path.endsWith('.jpg')).toBe(true);
      expect(s.missing([ha, hb, 'cafebabe'])).toEqual(['cafebabe']);

      const reloaded = new AssetStore(dir, 10);
      await reloaded.init();
      expect(reloaded.has(ha) && reloaded.has(hb)).toBe(true);

      // make `a` older → evicted first (12 bytes > 10 budget)
      const old = new Date(Date.now() - 60_000);
      await utimes(reloaded.get(ha)!.path, old, old);
      const r = await reloaded.prune();
      expect(r.removed).toBe(1);
      expect(reloaded.has(ha)).toBe(false);
      expect(reloaded.has(hb)).toBe(true);
      await expect(stat(join(dir, ha.slice(0, 2), `${ha}.png`))).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('logger', () => {
  it('emits structured JSON lines with bound fields and level filtering', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'info', sink: (l) => lines.push(l) });
    log.debug('hidden');
    log.child({ conn: 3 }).warn('hi', { err: new Error('boom') });
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec).toMatchObject({ level: 'warn', msg: 'hi', conn: 3, err: { message: 'boom' } });
  });
});
