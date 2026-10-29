#!/usr/bin/env node
/**
 * Standalone bridge for development: accepts syncs from the Figma plugin without After
 * Effects and writes each document (plus asset map) to an output directory.
 *
 *   node dist/cli.js [--out ./received] [--port 7741] [--verbose]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { BRIDGE_PORTS } from '@f2ae/shared/protocol';
import { AssetStore } from './asset-store';
import { createLogger } from './logger';
import { defaultPaths } from './paths';
import { BridgeServer, type BuildHost } from './server';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: './received' },
    port: { type: 'string' },
    verbose: { type: 'boolean', default: false },
  },
});

const outDir = resolve(values.out!);
const paths = defaultPaths();
const logger = createLogger({ level: values.verbose ? 'debug' : 'info', console: true, file: join(paths.logs, 'bridge-cli.log') });

const host: BuildHost = {
  info: () => ({ app: 'f2ae-bridge-cli', version: process.version }),
  async build(job) {
    const t0 = Date.now();
    await mkdir(outDir, { recursive: true });
    const file = join(outDir, `${job.syncId}.json`);
    await writeFile(file, JSON.stringify({ assetPaths: job.assetPaths, document: job.document }, null, 2));
    let nodes = 0;
    const stack = job.document.roots.map((r) => r.node);
    while (stack.length) {
      const n = stack.pop()!;
      nodes++;
      if (n.kind === 'container') stack.push(...n.children);
    }
    logger.info('document written', { file, nodes });
    return {
      ok: true,
      stats: { comps: job.document.roots.length, layers: 0, nodes, durationMs: Date.now() - t0 },
      warnings: [`dev bridge: document saved to ${file} (no After Effects build)`],
    };
  },
};

const server = new BridgeServer({
  host,
  assets: new AssetStore(paths.cache),
  logger,
  ports: values.port ? [Number(values.port)] : BRIDGE_PORTS,
});

server
  .start()
  .then((port) => {
    logger.info(`Figma2AE dev bridge on ws://localhost:${port}  (health: http://localhost:${port}/health)`, { outDir });
  })
  .catch((e: Error) => {
    logger.error('failed to start', { err: e.message });
    process.exit(1);
  });

const shutdown = (): void => {
  void server.stop().then(() => logger.close()).then(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
