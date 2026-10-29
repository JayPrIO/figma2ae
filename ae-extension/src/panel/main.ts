/**
 * CEP panel entry (Chromium + Node mixed context). Hosts the bridge server, renders status,
 * imports offline bundles. Plain DOM — no framework needed for this surface.
 */
import { join } from 'node:path';
import { AssetStore, BridgeServer, createLogger, defaultPaths, type LogLevel } from '@f2ae/bridge-server';
import type { BuildResult } from '@f2ae/shared/schema';
import { PRODUCT_VERSION } from '@f2ae/shared/version';
import { AeBuildHost } from './ae-host';
import { parseBundle } from './bundle';
import { createCep, type CepRuntime } from './cep';

declare global {
  interface Window {
    __adobe_cep__?: CepRuntime;
  }
}

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

interface ActivityItem {
  at: Date;
  ok: boolean;
  text: string;
  warnings: string[];
}

const activity: ActivityItem[] = [];

function renderActivity(): void {
  const list = $('activity');
  list.textContent = '';
  if (activity.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing received yet. In Figma, run Plugins ▸ Figma2AE ▸ Sync Selection.';
    list.appendChild(li);
    return;
  }
  for (const a of activity) {
    const li = document.createElement('li');
    li.className = a.ok ? 'ok' : 'err';
    const head = document.createElement('div');
    head.textContent = `${a.at.toLocaleTimeString()} · ${a.text}`;
    li.appendChild(head);
    if (a.warnings.length) {
      const d = document.createElement('details');
      const s = document.createElement('summary');
      s.textContent = `${a.warnings.length} note${a.warnings.length === 1 ? '' : 's'}`;
      d.appendChild(s);
      const ul = document.createElement('ul');
      for (const w of a.warnings.slice(0, 100)) {
        const wi = document.createElement('li');
        wi.textContent = w;
        ul.appendChild(wi);
      }
      d.appendChild(ul);
      li.appendChild(d);
    }
    list.appendChild(li);
  }
}

function record(result: BuildResult, source: string): void {
  activity.unshift({
    at: new Date(),
    ok: result.ok,
    text: result.ok
      ? `${source}: ${result.stats.layers} layers, ${result.stats.comps} comp${result.stats.comps === 1 ? '' : 's'} in ${(result.stats.durationMs / 1000).toFixed(1)}s`
      : `${source} failed: ${result.error ?? 'unknown error'}`,
    warnings: result.warnings,
  });
  activity.length = Math.min(activity.length, 20);
  renderActivity();
}

function setStatus(state: 'starting' | 'ready' | 'busy' | 'error', text: string): void {
  const el = $('status');
  el.className = `status ${state}`;
  $('status-text').textContent = text;
}

async function main(): Promise<void> {
  $('version').textContent = `v${PRODUCT_VERSION}`;
  renderActivity();
  const rt = window.__adobe_cep__;
  if (!rt) {
    setStatus('error', 'Not running inside After Effects');
    return;
  }
  const cep = createCep(rt);
  const paths = defaultPaths();
  const debug = localStorage.getItem('f2ae.debug') === '1';
  const logger = createLogger({
    level: (debug ? 'debug' : 'info') as LogLevel,
    file: join(paths.logs, 'bridge.log'),
    console: debug,
  });
  const host = new AeBuildHost({ cep, jobsDir: paths.jobs, jsxPath: join(cep.extensionPath(), 'jsx', 'f2ae.jsx'), logger });
  const assets = new AssetStore(paths.cache);
  const server = new BridgeServer({ host, assets, logger });

  let clients = 0;
  const refresh = (): void => {
    if (server.port) setStatus(clients > 0 ? 'ready' : 'ready', `Listening on :${server.port} · ${clients} Figma client${clients === 1 ? '' : 's'}`);
  };
  server.on('connection', () => {
    clients++;
    refresh();
  });
  server.on('disconnect', () => {
    clients = Math.max(0, clients - 1);
    refresh();
  });
  server.on('sync:building', () => setStatus('busy', 'Building layers…'));
  server.on('sync:done', (id, result) => {
    record(result, id.startsWith('local') ? 'Bundle' : 'Figma sync');
    refresh();
  });

  setStatus('starting', 'Starting bridge…');
  try {
    await host.ensureLoaded();
    await server.start();
    refresh();
    void assets.prune().then((r) => r.removed && logger.info('asset cache pruned', r));
  } catch (e) {
    logger.error('bridge failed to start', { err: e });
    setStatus('error', `Bridge failed: ${(e as Error).message}`);
  }

  $('import').addEventListener('click', () => $<HTMLInputElement>('file').click());
  $<HTMLInputElement>('file').addEventListener('change', async (ev) => {
    const input = ev.target as HTMLInputElement;
    const f = input.files?.[0];
    input.value = '';
    if (!f) return;
    try {
      setStatus('busy', `Importing ${f.name}…`);
      const bundle = parseBundle(await f.text());
      await server.buildLocal(bundle.document, bundle.assets);
    } catch (e) {
      record({ ok: false, stats: { comps: 0, layers: 0, nodes: 0, durationMs: 0 }, warnings: [], error: (e as Error).message }, 'Bundle');
      refresh();
    }
  });

  window.addEventListener('beforeunload', () => {
    void server.stop();
    void logger.close();
  });
}

void main();
