import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { encodeAssetFrame, type ServerMessage } from '@f2ae/shared/protocol';
import { DEFAULT_BUILD_OPTIONS, type F2AEDocument, type SceneNode } from '@f2ae/shared/schema';
import { AssetStore } from '../src/asset-store';
import { BridgeServer, type BuildHost, type BuildJob } from '../src/server';

function doc(assets: string[] = []): F2AEDocument {
  const node: SceneNode = {
    kind: 'shape',
    id: '1:1',
    name: 'Rect',
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
  return {
    schemaVersion: 1,
    generator: { name: 'test', version: '0' },
    createdAt: 0,
    source: { fileName: 'f', pageName: 'p' },
    options: DEFAULT_BUILD_OPTIONS,
    roots: [{ node, size: { w: 10, h: 10 }, canvasOrigin: [0, 0] }],
    assets: assets.map((hash) => ({ hash, mime: 'image/png', width: 1, height: 1, byteLength: 3 })),
    fonts: [],
    warnings: [],
  };
}

/** Test client that records server messages and lets tests await specific ones. */
class Client {
  readonly msgs: ServerMessage[] = [];
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString()) as ServerMessage;
      this.msgs.push(m);
      this.waiters = this.waiters.filter((w) => (w.pred(m) ? (w.resolve(m), false) : true));
    });
  }
  static async connect(port: number, origin?: string): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
      ws.once('unexpected-response', (_req, r) => rej(new Error(`HTTP ${r.statusCode}`)));
    });
    return new Client(ws);
  }
  send(o: unknown): void {
    this.ws.send(JSON.stringify(o));
  }
  next<T extends ServerMessage['type']>(type: T, timeoutMs = 5000): Promise<Extract<ServerMessage, { type: T }>> {
    const found = this.msgs.find((m) => m.type === type);
    if (found) {
      this.msgs.splice(this.msgs.indexOf(found), 1);
      return Promise.resolve(found as Extract<ServerMessage, { type: T }>);
    }
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        pred: (m) => m.type === type,
        resolve: (m) => {
          clearTimeout(t);
          this.msgs.splice(this.msgs.indexOf(m), 1);
          resolve(m as Extract<ServerMessage, { type: T }>);
        },
      });
    });
  }
  async hello(): Promise<void> {
    this.send({ type: 'hello', protocol: 1, client: 'test', clientVersion: '0' });
    await this.next('welcome');
  }
  close(): void {
    this.ws.close();
  }
}

describe('BridgeServer', () => {
  let dir: string;
  let server: BridgeServer;
  let port: number;
  let jobs: BuildJob[];
  let buildImpl: (job: BuildJob) => Promise<void>;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'f2ae-test-'));
    jobs = [];
    buildImpl = async () => undefined;
    const host: BuildHost = {
      info: () => ({ app: 'test-host', version: '1' }),
      build: async (job) => {
        jobs.push(job);
        await buildImpl(job);
        return { ok: true, stats: { comps: 1, layers: 1, nodes: 1, durationMs: 1 }, warnings: [] };
      },
    };
    server = new BridgeServer({
      host,
      assets: new AssetStore(join(dir, 'assets')),
      ports: [0],
      bindAddresses: ['127.0.0.1'],
      idleTimeoutMs: 60_000,
    });
    port = await server.start();
  });

  afterEach(async () => {
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('serves /health and /metrics', async () => {
    const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
    expect(health).toMatchObject({ ok: true, protocol: 1, host: { app: 'test-host' } });
    const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    expect(metrics).toContain('# TYPE f2ae_build_ms histogram');
    expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
  });

  it('rejects disallowed origins at upgrade', async () => {
    await expect(Client.connect(port, 'https://evil.example')).rejects.toThrow(/403/);
    expect(server.metrics.connectionsRejected.value).toBe(1);
    const ok = await Client.connect(port, 'null');
    ok.close();
  });

  it('requires hello before syncing and enforces protocol version', async () => {
    const c = await Client.connect(port);
    c.send({ type: 'sync.begin', syncId: 'abcd1234', assets: [] });
    expect((await c.next('error')).code).toBe('NOT_READY');
    c.send({ type: 'hello', protocol: 99, client: 'test', clientVersion: '0' });
    expect((await c.next('error')).code).toBe('PROTOCOL_MISMATCH');
  });

  it('answers pings and reports malformed frames', async () => {
    const c = await Client.connect(port);
    c.send({ type: 'ping', t: 42 });
    expect((await c.next('pong')).t).toBe(42);
    c.ws.send('{oops');
    expect((await c.next('error')).code).toBe('BAD_MESSAGE');
    c.close();
  });

  it('runs a full sync with asset upload, dedupe on the second sync, and result', async () => {
    const bytes = new Uint8Array([137, 80, 78]);
    const hash = createHash('sha1').update(bytes).digest('hex');
    const c = await Client.connect(port);
    await c.hello();

    c.send({ type: 'sync.begin', syncId: 'sync0001', assets: [{ hash, mime: 'image/png', byteLength: 3 }] });
    expect((await c.next('sync.need')).hashes).toEqual([hash]);
    c.ws.send(encodeAssetFrame({ syncId: 'sync0001', hash, mime: 'image/png' }, bytes));
    c.send({ type: 'sync.commit', syncId: 'sync0001', document: doc([hash]) });
    const result = await c.next('sync.result');
    expect(result.ok).toBe(true);
    expect(jobs).toHaveLength(1);
    const p = jobs[0].assetPaths[hash];
    expect(Array.from(await readFile(p))).toEqual([137, 80, 78]);

    c.send({ type: 'sync.begin', syncId: 'sync0002', assets: [{ hash, mime: 'image/png', byteLength: 3 }] });
    expect((await c.next('sync.need')).hashes).toEqual([]);
    c.send({ type: 'sync.commit', syncId: 'sync0002', document: doc([hash]) });
    expect((await c.next('sync.result')).ok).toBe(true);
    expect(server.metrics.assetsDeduped.value).toBe(1);
    expect(server.metrics.syncsSucceeded.value).toBe(2);
    c.close();
  });

  it('rejects assets that fail SHA-1 verification and commits with missing assets', async () => {
    const hash = 'a'.repeat(40);
    const c = await Client.connect(port);
    await c.hello();
    c.send({ type: 'sync.begin', syncId: 'sync0003', assets: [{ hash, mime: 'image/png', byteLength: 1 }] });
    await c.next('sync.need');
    c.ws.send(encodeAssetFrame({ syncId: 'sync0003', hash, mime: 'image/png' }, new Uint8Array([1])));
    expect((await c.next('error')).message).toMatch(/SHA-1/);
    c.send({ type: 'sync.commit', syncId: 'sync0003', document: doc([hash]) });
    expect((await c.next('error')).code).toBe('ASSET_MISSING');
    expect(jobs).toHaveLength(0);
  });

  it('rejects invalid documents', async () => {
    const c = await Client.connect(port);
    await c.hello();
    c.send({ type: 'sync.begin', syncId: 'sync0004', assets: [] });
    await c.next('sync.need');
    c.send({ type: 'sync.commit', syncId: 'sync0004', document: { schemaVersion: 1, roots: 'x' } });
    expect((await c.next('error')).code).toBe('INVALID_DOCUMENT');
  });

  it('serialises builds and applies backpressure when the queue is full', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let concurrent = 0;
    let maxConcurrent = 0;
    buildImpl = async () => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await gate;
      concurrent--;
    };
    const c = await Client.connect(port);
    await c.hello();
    const ids = ['q0000001', 'q0000002', 'q0000003', 'q0000004', 'q0000005', 'q0000006'];
    for (const id of ids) {
      c.send({ type: 'sync.begin', syncId: id, assets: [] });
      await c.next('sync.need');
      c.send({ type: 'sync.commit', syncId: id, document: doc() });
    }
    // 1 running + 4 waiting (maxQueuedBuilds) → 6th is BUSY
    const err = await c.next('error');
    expect(err.code).toBe('BUSY');
    release();
    for (let i = 0; i < 5; i++) expect((await c.next('sync.result')).ok).toBe(true);
    expect(maxConcurrent).toBe(1);
    c.close();
  });

  it('drops idle connections', async () => {
    await server.stop();
    const host: BuildHost = {
      info: () => ({ app: 'x', version: '1' }),
      build: async () => ({ ok: true, stats: { comps: 0, layers: 0, nodes: 0, durationMs: 0 }, warnings: [] }),
    };
    server = new BridgeServer({
      host,
      assets: new AssetStore(join(dir, 'a2')),
      ports: [0],
      bindAddresses: ['127.0.0.1'],
      idleTimeoutMs: 300,
    });
    port = await server.start();
    const c = await Client.connect(port);
    // Disable automatic pong replies so the client looks dead.
    (c.ws as unknown as { pong: () => void }).pong = () => undefined;
    (c.ws as unknown as { _receiver: { removeAllListeners: (e: string) => void } })._receiver.removeAllListeners('ping');
    const closed = new Promise<void>((r) => c.ws.once('close', () => r()));
    await closed;
    expect(server.connectionCount).toBe(0);
  });

  it('builds offline bundles through the same queue (buildLocal)', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const hash = createHash('sha1').update(bytes).digest('hex');
    const r = await server.buildLocal(doc([hash]), [{ hash, mime: 'image/png', bytes }]);
    expect(r.ok).toBe(true);
    expect(Object.keys(jobs[0].assetPaths)).toEqual([hash]);
    await expect(server.buildLocal({ ...doc(), roots: 'x' } as unknown as F2AEDocument, [])).rejects.toThrow(/invalid document/);
  });

  it('falls back to the next port when the first is taken', async () => {
    const second = new BridgeServer({
      host: { info: () => ({ app: 'x', version: '1' }), build: async () => ({ ok: true, stats: { comps: 0, layers: 0, nodes: 0, durationMs: 0 }, warnings: [] }) },
      assets: new AssetStore(join(dir, 'a3')),
      ports: [port, 0],
      bindAddresses: ['127.0.0.1'],
    });
    const p2 = await second.start();
    expect(p2).not.toBe(port);
    await second.stop();
  });
});
