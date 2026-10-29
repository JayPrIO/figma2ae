/**
 * Panel-side tests, culminating in a full-chain E2E:
 *   Figma extractor → UI transport (ws) → BridgeServer → AeBuildHost → evalScript →
 *   compiled f2ae.jsx running in the mocked AE DOM.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { AssetStore, BridgeServer, createLogger } from '@f2ae/bridge-server';
import { DEFAULT_BUILD_OPTIONS } from '@f2ae/shared/schema';
// @ts-expect-error — plain ESM build script
import { buildJsx } from '../build-jsx.mjs';
import { extractSelection } from '../../figma-plugin/src/main/extract';
import { makeBundle, preparePayload } from '../../figma-plugin/src/ui/prepare';
import { BridgeClient, type WebSocketCtor } from '../../figma-plugin/src/ui/transport';
import { fakeApi, node, solid, text as figmaText, tx } from '../../figma-plugin/test/fake-figma';
import { AeBuildHost, toExtendScriptJson } from '../src/panel/ae-host';
import { parseBundle } from '../src/panel/bundle';
import { createCep, EVAL_ERROR, type CepRuntime } from '../src/panel/cep';
import { createAe, type AeEnv } from './ae-mock';

let code = '';
let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'f2ae-panel-'));
  code = (await buildJsx({ outfile: join(dir, 'f2ae.jsx') })).code;
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** CEP runtime backed by the mocked AE VM: evalScript really executes ExtendScript. */
function cepFor(ae: AeEnv, opts: { failFirstLookup?: boolean } = {}): CepRuntime & { calls: string[] } {
  let lookups = 0;
  const calls: string[] = [];
  return {
    calls,
    evalScript(script, cb) {
      calls.push(script);
      setTimeout(() => {
        try {
          if (opts.failFirstLookup && script.includes('typeof F2AE') && lookups++ === 0) return cb('missing');
          if (script.startsWith('$.evalFile(')) {
            vm.runInContext(code, ae.context);
            return cb(String(vm.runInContext('F2AE.version', ae.context)));
          }
          cb(String(vm.runInContext(script, ae.context)));
        } catch {
          cb(EVAL_ERROR);
        }
      }, 0);
    },
    getSystemPath: () => 'file:///Library/Application%20Support/Adobe/CEP/extensions/io.jaypr.figma2ae',
    getHostEnvironment: () => JSON.stringify({ appVersion: '25.0.1' }),
  };
}

describe('cep wrapper', () => {
  it('decodes extension paths and host version', () => {
    const ae = createAe(code);
    const cep = createCep(cepFor(ae));
    expect(cep.extensionPath()).toBe('/Library/Application Support/Adobe/CEP/extensions/io.jaypr.figma2ae');
    expect(cep.hostVersion()).toBe('25.0.1');
  });

  it('times out hung evalScript calls', async () => {
    const cep = createCep({ evalScript: () => undefined, getSystemPath: () => '', getHostEnvironment: () => '{}' });
    await expect(cep.evalScript('x', 20)).rejects.toThrow(/timed out/);
  });
});

describe('AeBuildHost', () => {
  it('escapes U+2028/2029 so the ExtendScript eval path parses text containing them', async () => {
    const s = toExtendScriptJson({ t: 'a\u2028b\u2029c' });
    expect(s).not.toMatch(/[\u2028\u2029]/);
    expect(JSON.parse(s).t).toBe('a\u2028b\u2029c');
  });

  it('reloads the jsx when the engine lost F2AE, writes a job file, and cleans it up', async () => {
    const ae = createAe(code);
    const rt = cepFor(ae, { failFirstLookup: true });
    const jobs = join(dir, 'jobs-a');
    const host = new AeBuildHost({ cep: createCep(rt), jobsDir: jobs, jsxPath: '/x/f2ae.jsx', logger: createLogger() });
    const ex = await extractSelection([node('FRAME', { width: 200, height: 100, fills: [solid(1, 1, 1)], children: [node('RECTANGLE', { absoluteTransform: tx(10, 10), width: 20, height: 20 })] })], DEFAULT_BUILD_OPTIONS, fakeApi(), { fileName: 'f', pageName: 'p' });
    const r = await host.build({ syncId: 'abcd1234', document: ex.document, assetPaths: {} });
    expect(r.ok).toBe(true);
    expect(r.stats.layers).toBe(2);
    expect(rt.calls.some((c) => c.startsWith('$.evalFile('))).toBe(true);
    expect(await readdir(jobs)).toEqual([]);
  });

  it('turns ExtendScript exceptions into failed results', async () => {
    const host = new AeBuildHost({
      cep: createCep({ evalScript: (s, cb) => cb(s.includes('typeof') ? '1.0.0' : EVAL_ERROR), getSystemPath: () => '', getHostEnvironment: () => '{}' }),
      jobsDir: join(dir, 'jobs-b'),
      jsxPath: '/x',
      logger: createLogger(),
    });
    const r = await host.build({ syncId: 'abcd1234', document: { roots: [] } as never, assetPaths: {} });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/ExtendScript raised an error/) });
  });
});

describe('bundle import', () => {
  it('round-trips a bundle produced by the Figma plugin and rejects corrupted ones', async () => {
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const ex = await extractSelection([node('RECTANGLE', { fills: [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: 'h' }] })], DEFAULT_BUILD_OPTIONS, fakeApi({ h: { bytes: png, w: 4, h: 4 } }), { fileName: 'f', pageName: 'p' });
    const { document, assets } = await preparePayload(ex.document, ex.assets);
    const parsed = parseBundle(makeBundle(document, assets));
    expect(parsed.assets[0].hash).toBe(createHash('sha1').update(png).digest('hex'));
    expect(Array.from(parsed.assets[0].bytes)).toEqual(Array.from(png));

    const bad = JSON.parse(makeBundle(document, assets));
    bad.assets[assets[0].hash].base64 = Buffer.from([9, 9]).toString('base64');
    expect(() => parseBundle(JSON.stringify(bad))).toThrow(/corrupted/);
    expect(() => parseBundle('{"format":"nope"}')).toThrow(/Not a Figma2AE bundle/);
  });
});

describe('full chain E2E', () => {
  it('Figma selection → ws → bridge → ExtendScript → AE layers', async () => {
    const ae = createAe(code);
    const host = new AeBuildHost({ cep: createCep(cepFor(ae)), jobsDir: join(dir, 'jobs-e2e'), jsxPath: '/x', logger: createLogger() });
    const server = new BridgeServer({ host, assets: new AssetStore(join(dir, 'assets-e2e')), ports: [0], bindAddresses: ['127.0.0.1'] });
    const port = await server.start();
    const client = new BridgeClient({ WebSocket: WebSocket as unknown as WebSocketCtor, clientVersion: 'e2e', hostname: '127.0.0.1', ports: [port] });
    try {
      client.start();
      const t0 = Date.now();
      while (!client.connected) {
        if (Date.now() - t0 > 5000) throw new Error('no connection');
        await new Promise((r) => setTimeout(r, 5));
      }
      const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 7]);
      const selection = [
        node('FRAME', {
          name: 'Hero',
          width: 400,
          height: 300,
          fills: [solid(0.1, 0.1, 0.1)],
          children: [
            node('RECTANGLE', { name: 'Photo', absoluteTransform: tx(20, 20), width: 160, height: 90, cornerRadius: 12, fills: [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: 'img' }] }),
            figmaText('Headline', { name: 'Headline', absoluteTransform: tx(20, 140), width: 300, height: 40 }),
            node('ELLIPSE', { name: 'Dot', absoluteTransform: tx(300, 30), width: 40, height: 40, fills: [solid(1, 0.3, 0)], arcData: { startingAngle: 0, endingAngle: 2 * Math.PI, innerRadius: 0 } }),
          ],
        }),
      ];
      const ex = await extractSelection(selection, DEFAULT_BUILD_OPTIONS, fakeApi({ img: { bytes: png, w: 1600, h: 900 } }), { fileName: 'f', pageName: 'p' });
      const { document, assets } = await preparePayload(ex.document, ex.assets);
      const result = await client.sync(document, assets);
      expect(result.ok).toBe(true);
      expect(result.stats).toMatchObject({ comps: 1, layers: 4 });

      const [comp] = ae.comps();
      expect(comp.name).toBe('Hero');
      expect(comp.stack.map((l) => l.name)).toEqual(['Dot', 'Headline', 'Photo', 'Hero']);
      expect(comp.stack.slice(0, 3).every((l) => l.parent === comp.stack[3])).toBe(true);
      expect(ae.footage()).toHaveLength(1);
      expect(server.metrics.syncsSucceeded.value).toBe(1);
    } finally {
      client.stop();
      await server.stop();
    }
  });
});
