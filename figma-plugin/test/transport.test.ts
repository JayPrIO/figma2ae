/**
 * End-to-end: Figma UI transport ↔ real BridgeServer over loopback sockets.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AssetStore, BridgeServer, type BuildHost, type BuildJob } from '@f2ae/bridge-server';
import { DEFAULT_BUILD_OPTIONS } from '@f2ae/shared/schema';
import { extractSelection } from '../src/main/extract';
import { makeBundle, preparePayload, sha1Hex } from '../src/ui/prepare';
import { BridgeClient, SyncError, type ConnectionStatus, type WebSocketCtor } from '../src/ui/transport';
import { fakeApi, node } from './fake-figma';

const WS = WebSocket as unknown as WebSocketCtor;

function until(pred: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      if (pred()) resolve();
      else if (Date.now() - t0 > ms) reject(new Error('until: timeout'));
      else setTimeout(tick, 5);
    };
    tick();
  });
}

describe('BridgeClient ↔ BridgeServer', () => {
  let dir: string;
  let server: BridgeServer;
  let port: number;
  let jobs: BuildJob[];
  let client: BridgeClient | null = null;

  const host: BuildHost = {
    info: () => ({ app: 'After Effects', version: '25.0' }),
    build: async (job) => {
      jobs.push(job);
      return { ok: true, stats: { comps: 1, layers: 3, nodes: 3, durationMs: 5 }, warnings: ['w1'] };
    },
  };

  async function startServer(p = 0): Promise<void> {
    server = new BridgeServer({ host, assets: new AssetStore(join(dir, 'assets')), ports: [p], bindAddresses: ['127.0.0.1'] });
    port = await server.start();
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'f2ae-e2e-'));
    jobs = [];
    await startServer();
  });

  afterEach(async () => {
    client?.stop();
    client = null;
    await server.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('connects (scanning past dead ports), syncs extracted content, and dedupes assets', async () => {
    const statuses: ConnectionStatus[] = [];
    client = new BridgeClient({ WebSocket: WS, clientVersion: 't', hostname: '127.0.0.1', ports: [1, port], onStatus: (s) => statuses.push(s) });
    client.start();
    await until(() => client!.connected);
    expect(client.connection).toMatchObject({ state: 'connected', port, host: { app: 'After Effects' } });

    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const api = fakeApi({ h1: { bytes: png, w: 10, h: 10 } });
    const rect = node('RECTANGLE', { fills: [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: 'h1' }] });
    const ex = await extractSelection([node('FRAME', { children: [rect] })], DEFAULT_BUILD_OPTIONS, api, { fileName: 'f', pageName: 'p' });
    const { document, assets } = await preparePayload(ex.document, ex.assets);
    expect(assets[0].hash).toBe(await sha1Hex(png));

    const phases: string[] = [];
    const res = await client.sync(document, assets, (p) => phases.push(p.phase));
    expect(res).toMatchObject({ ok: true, stats: { layers: 3 }, warnings: ['w1'] });
    expect(phases).toEqual(expect.arrayContaining(['uploading', 'received', 'queued', 'building']));
    expect(Object.keys(jobs[0].assetPaths)).toEqual([assets[0].hash]);

    phases.length = 0;
    await client.sync(document, assets, (p) => phases.push(p.phase));
    expect(phases).not.toContain('uploading');
  });

  it('fails in-flight syncs fast on disconnect and reconnects with backoff', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    host.build = async () => {
      await gate;
      return { ok: true, stats: { comps: 0, layers: 0, nodes: 0, durationMs: 0 }, warnings: [] };
    };
    client = new BridgeClient({ WebSocket: WS, clientVersion: 't', hostname: '127.0.0.1', ports: [port], backoffMinMs: 20, backoffMaxMs: 50 });
    client.start();
    await until(() => client!.connected);
    const ex = await extractSelection([node('RECTANGLE')], DEFAULT_BUILD_OPTIONS, fakeApi(), { fileName: 'f', pageName: 'p' });
    const pending = client.sync(ex.document, []);
    await until(() => server.metrics.queueDepth.value > 0);
    await server.stop();
    await expect(pending).rejects.toBeInstanceOf(SyncError);
    release();
    expect(client.connection.state).not.toBe('connected');

    await startServer(port);
    await until(() => client!.connected, 5000);
  });

  it('rejects sync while disconnected', async () => {
    client = new BridgeClient({ WebSocket: WS, clientVersion: 't', hostname: '127.0.0.1', ports: [1], backoffMinMs: 1000 });
    client.start();
    await until(() => client!.connection.state === 'disconnected');
    const ex = await extractSelection([node('RECTANGLE')], DEFAULT_BUILD_OPTIONS, fakeApi(), { fileName: 'f', pageName: 'p' });
    await expect(client.sync(ex.document, [])).rejects.toMatchObject({ code: 'NOT_CONNECTED' });
  });

  it('builds an offline bundle with base64 assets', async () => {
    const png = new Uint8Array(70_000).map((_, i) => i % 251);
    const ex = await extractSelection(
      [node('RECTANGLE', { fills: [{ type: 'IMAGE', scaleMode: 'FIT', imageHash: 'h' }] })],
      DEFAULT_BUILD_OPTIONS,
      fakeApi({ h: { bytes: png, w: 1, h: 1 } }),
      { fileName: 'f', pageName: 'p' },
    );
    const { document, assets } = await preparePayload(ex.document, ex.assets);
    const bundle = JSON.parse(makeBundle(document, assets));
    expect(bundle.format).toBe('f2ae-bundle');
    const b64 = bundle.assets[assets[0].hash].base64 as string;
    expect(Buffer.from(b64, 'base64').equals(Buffer.from(png))).toBe(true);
  });
});
