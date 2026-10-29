import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { DEFAULT_BUILD_OPTIONS, type BuildOptions } from '@f2ae/shared/schema';
import { PRODUCT_VERSION } from '@f2ae/shared/version';
import type { ExportedFile, ExportFormat, MainToUi, SelectionInfo, UiToMain } from '../messages';
import { makeBundle, preparePayload } from './prepare';
import { uniqueNames, zip } from './zip';
import { BridgeClient, SyncError, type ConnectionStatus, type SyncProgress } from './transport';

type Phase =
  | { kind: 'idle' }
  | { kind: 'extracting'; nodes: number }
  | { kind: 'sending'; progress: SyncProgress }
  | { kind: 'done'; layers: number; comps: number; ms: number; warnings: string[] }
  | { kind: 'error'; message: string; warnings: string[] };

function toMain(msg: UiToMain): void {
  parent.postMessage({ pluginMessage: msg }, '*');
}

let requestSeq = 0;

function extract(options: BuildOptions): Promise<Extract<MainToUi, { type: 'extract:done' }>> {
  const requestId = ++requestSeq;
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent): void => {
      const m = ev.data?.pluginMessage as MainToUi | undefined;
      if (!m) return;
      if (m.type === 'extract:done' && m.requestId === requestId) {
        window.removeEventListener('message', onMsg);
        resolve(m);
      } else if (m.type === 'extract:error' && m.requestId === requestId) {
        window.removeEventListener('message', onMsg);
        reject(new Error(m.message));
      }
    };
    window.addEventListener('message', onMsg);
    toMain({ type: 'extract', requestId, options });
  });
}

type ExportChoice = 'bundle' | ExportFormat;
const EXPORT_LABEL: Record<ExportChoice, string> = { bundle: 'AE bundle', PNG: 'PNG', SVG: 'SVG', PDF: 'PDF' };
const MIME: Record<ExportFormat, string> = { PNG: 'image/png', SVG: 'image/svg+xml', PDF: 'application/pdf' };

function exportFiles(format: ExportFormat, scale: number): Promise<ExportedFile[]> {
  const requestId = ++requestSeq;
  return new Promise((resolve, reject) => {
    const onMsg = (ev: MessageEvent): void => {
      const m = ev.data?.pluginMessage as MainToUi | undefined;
      if (!m || !('requestId' in m) || m.requestId !== requestId) return;
      if (m.type === 'export:done') {
        window.removeEventListener('message', onMsg);
        resolve(m.files);
      } else if (m.type === 'export:error') {
        window.removeEventListener('message', onMsg);
        reject(new Error(m.message));
      }
    };
    window.addEventListener('message', onMsg);
    toMain({ type: 'export', requestId, format, scale });
  });
}

function download(name: string, data: string | Uint8Array, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function phaseLabel(p: SyncProgress): string {
  switch (p.phase) {
    case 'uploading':
      return `Uploading images ${p.uploaded}/${p.total}…`;
    case 'received':
      return 'Received by After Effects…';
    case 'queued':
      return p.position && p.position > 1 ? `Queued (#${p.position})…` : 'Starting build…';
    case 'building':
      return 'Building layers in After Effects…';
  }
}

function Toggle(props: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; primary?: boolean }) {
  return (
    <label class={`toggle ${props.primary ? 'primary' : ''}`}>
      <span class="toggle-text">
        <span class="toggle-label">{props.label}</span>
        {props.hint && <span class="toggle-hint">{props.hint}</span>}
      </span>
      <input type="checkbox" role="switch" checked={props.checked} onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)} />
      <span class="switch" aria-hidden="true" />
    </label>
  );
}

function StatusPill({ status }: { status: ConnectionStatus }) {
  const [, force] = useState(0);
  useEffect(() => {
    if (status.state !== 'disconnected') return;
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [status]);
  const text =
    status.state === 'connected'
      ? `After Effects ${status.host?.version ?? ''}`.trim()
      : status.state === 'connecting'
        ? 'Looking for After Effects…'
        : status.state === 'disconnected'
          ? 'After Effects not found'
          : 'Offline';
  return (
    <div class={`pill ${status.state}`} title={status.lastError ?? ''}>
      <span class="dot" />
      {text}
    </div>
  );
}

export function App() {
  const [options, setOptions] = useState<BuildOptions>(DEFAULT_BUILD_OPTIONS);
  const [selection, setSelection] = useState<SelectionInfo>({ count: 0, names: [], frames: 0 });
  const [status, setStatus] = useState<ConnectionStatus>({ state: 'idle', attempt: 0 });
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [exportChoice, setExportChoice] = useState<ExportChoice>(() => {
    try {
      return (localStorage.getItem('f2ae.export') as ExportChoice) || 'bundle';
    } catch {
      return 'bundle';
    }
  });
  const fileName = useRef('figma');
  const rootRef = useRef<HTMLDivElement>(null);

  const client = useMemo(
    () =>
      new BridgeClient({
        WebSocket: WebSocket as unknown as ConstructorParameters<typeof BridgeClient>[0]['WebSocket'],
        clientVersion: PRODUCT_VERSION,
        onStatus: setStatus,
      }),
    [],
  );

  useEffect(() => {
    const onMsg = (ev: MessageEvent): void => {
      const m = ev.data?.pluginMessage as MainToUi | undefined;
      if (!m) return;
      if (m.type === 'init') {
        setOptions(m.options);
        setSelection(m.selection);
        fileName.current = m.fileName;
      } else if (m.type === 'selection') setSelection(m.selection);
      else if (m.type === 'extract:progress') setPhase({ kind: 'extracting', nodes: m.nodes });
    };
    window.addEventListener('message', onMsg);
    toMain({ type: 'ready' });
    client.start();
    return () => {
      window.removeEventListener('message', onMsg);
      client.stop();
    };
  }, [client]);

  // auto-size the plugin window to content
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => toMain({ type: 'resize', height: el.scrollHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const update = useCallback((patch: Partial<BuildOptions>) => {
    setOptions((o) => {
      const next = { ...o, ...patch };
      toMain({ type: 'options:save', options: next });
      return next;
    });
  }, []);

  const busy = phase.kind === 'extracting' || phase.kind === 'sending';

  const run = useCallback(
    async (mode: 'sync' | 'export') => {
      if (busy) return;
      if (mode === 'export' && exportChoice !== 'bundle') {
        setPhase({ kind: 'extracting', nodes: 0 });
        const t0 = performance.now();
        try {
          const files = await exportFiles(exportChoice, options.imageScale);
          const ext = exportChoice.toLowerCase();
          const names = uniqueNames(
            files.map((f) => f.name),
            ext,
          );
          if (files.length === 1) download(names[0], files[0].bytes, MIME[exportChoice]);
          else {
            const base = (fileName.current || 'figma').replace(/[^\w.-]+/g, '_').slice(0, 60);
            download(`${base}-${ext}.zip`, zip(files.map((f, i) => ({ name: names[i], data: f.bytes }))), 'application/zip');
          }
          const note = exportChoice === 'PNG' ? [`Exported at ${options.imageScale}× (Advanced ▸ Image scale)`] : [];
          setPhase({ kind: 'done', layers: 0, comps: 0, ms: Math.round(performance.now() - t0), warnings: [`Saved ${files.length} ${exportChoice} file${files.length === 1 ? '' : 's'}`, ...note] });
        } catch (e) {
          setPhase({ kind: 'error', message: (e as Error).message, warnings: [] });
        }
        return;
      }
      setPhase({ kind: 'extracting', nodes: 0 });
      let warnings: string[] = [];
      try {
        const ex = await extract(options);
        const { document, assets } = await preparePayload(ex.document, ex.assets);
        warnings = document.warnings;
        if (mode === 'export') {
          const safe = (document.roots[0]?.node.name ?? fileName.current).replace(/[^\w.-]+/g, '_').slice(0, 60);
          download(`${safe}.f2ae.json`, makeBundle(document, assets));
          setPhase({ kind: 'done', layers: 0, comps: 0, ms: ex.ms, warnings: ['Saved bundle — import it from the After Effects panel.', ...warnings] });
          return;
        }
        setPhase({ kind: 'sending', progress: { phase: 'uploading', uploaded: 0, total: assets.length } });
        const t0 = performance.now();
        const result = await client.sync(document, assets, (p) => setPhase({ kind: 'sending', progress: p }));
        const all = [...warnings, ...result.warnings];
        if (!result.ok) {
          setPhase({ kind: 'error', message: result.error ?? 'Build failed in After Effects', warnings: all });
          toMain({ type: 'notify', message: 'Figma2AE: build failed', error: true });
          return;
        }
        setPhase({ kind: 'done', layers: result.stats.layers, comps: result.stats.comps, ms: Math.round(ex.ms + performance.now() - t0), warnings: all });
        toMain({ type: 'notify', message: `Sent ${result.stats.layers} layers to After Effects` });
      } catch (e) {
        const msg = e instanceof SyncError && e.code === 'NOT_CONNECTED' ? 'After Effects is not connected. Open the Figma2AE panel in AE (Window ▸ Extensions), or use Export.' : (e as Error).message;
        setPhase({ kind: 'error', message: msg, warnings });
      }
    },
    [busy, client, options, exportChoice],
  );

  const canSync = selection.count > 0 && !busy;

  return (
    <div class="app" ref={rootRef}>
      <header>
        <div class="brand">
          Figma<span>2</span>AE
        </div>
        <StatusPill status={status} />
      </header>

      <section class="selection">
        {selection.count === 0 ? (
          <span class="muted">Select frames or layers to send</span>
        ) : (
          <span>
            <strong>{selection.count}</strong> selected · {selection.names.join(', ')}
            {selection.count > selection.names.length ? '…' : ''}
          </span>
        )}
      </section>

      <section class="options">
        <Toggle
          primary
          label="Break Apart Layers"
          hint={options.breakApart ? 'Every layer becomes its own AE layer, parented' : 'Each selection becomes one grouped shape layer'}
          checked={options.breakApart}
          onChange={(v) => update({ breakApart: v })}
        />
        <button class="link" onClick={() => setShowAdvanced((s) => !s)}>
          {showAdvanced ? '▾' : '▸'} Advanced
        </button>
        {showAdvanced && (
          <div class="advanced">
            <Toggle
              label="Clipped frames as precomps"
              hint="Off: clip with track mattes in one comp"
              checked={options.clippedFramesAsPrecomps}
              onChange={(v) => update({ clippedFramesAsPrecomps: v })}
              />
            <Toggle label="Include hidden layers" checked={options.includeHidden} onChange={(v) => update({ includeHidden: v })} />
            <div class="row">
              <span>Destination</span>
              <select value={options.target} onChange={(e) => update({ target: (e.target as HTMLSelectElement).value as BuildOptions['target'] })}>
                <option value="newComp">New comp per frame</option>
                <option value="activeComp">Active comp</option>
              </select>
            </div>
            <div class="row">
              <span>Image scale</span>
              <select value={String(options.imageScale)} onChange={(e) => update({ imageScale: Number((e.target as HTMLSelectElement).value) })}>
                {[1, 2, 3, 4].map((s) => (
                  <option value={String(s)}>{s}×</option>
                ))}
              </select>
            </div>
            <div class="row">
              <span>Frame rate</span>
              <select value={String(options.frameRate)} onChange={(e) => update({ frameRate: Number((e.target as HTMLSelectElement).value) })}>
                {[24, 25, 30, 50, 60].map((f) => (
                  <option value={String(f)}>{f} fps</option>
                ))}
              </select>
            </div>
            <div class="row">
              <span>Duration</span>
              <input
                type="number"
                min={1}
                max={3600}
                value={options.duration}
                onChange={(e) => update({ duration: Math.max(1, Math.min(3600, Number((e.target as HTMLInputElement).value) || 10)) })}
              />
            </div>
          </div>
        )}
      </section>

      <section class="actions">
        <button class="primary" disabled={!canSync || status.state !== 'connected'} onClick={() => void run('sync')}>
          {busy ? 'Working…' : 'Sync Selection'}
        </button>
      </section>
      <section class="actions export">
        <select
          value={exportChoice}
          aria-label="Export format"
          onChange={(e) => {
            const v = (e.target as HTMLSelectElement).value as ExportChoice;
            setExportChoice(v);
            try {
              localStorage.setItem('f2ae.export', v);
            } catch {
              /* storage unavailable */
            }
          }}
        >
          {(Object.keys(EXPORT_LABEL) as ExportChoice[]).map((k) => (
            <option value={k}>{EXPORT_LABEL[k]}</option>
          ))}
        </select>
        <button
          class="secondary"
          disabled={!canSync}
          onClick={() => void run('export')}
          title={exportChoice === 'bundle' ? 'Save a .f2ae.json bundle to import in the After Effects panel' : `Save the selection as ${exportChoice} (several layers → .zip)`}
        >
          Export {EXPORT_LABEL[exportChoice]}
        </button>
      </section>
      {status.state === 'disconnected' && (
        <div class="hint">
          Open <strong>Window ▸ Extensions ▸ Figma2AE</strong> in After Effects.{' '}
          <button class="link" onClick={() => client.retryNow()}>
            Retry now
          </button>
        </div>
      )}

      <section class="result" aria-live="polite">
        {phase.kind === 'extracting' && <div class="progress">Reading layers{phase.nodes ? ` (${phase.nodes})` : ''}…</div>}
        {phase.kind === 'sending' && <div class="progress">{phaseLabel(phase.progress)}</div>}
        {phase.kind === 'done' && (
          <div class="ok">
            ✓ {phase.layers ? `${phase.layers} layers in ${phase.comps} comp${phase.comps === 1 ? '' : 's'}` : 'Done'} · {(phase.ms / 1000).toFixed(1)}s
          </div>
        )}
        {phase.kind === 'error' && <div class="err">{phase.message}</div>}
        {(phase.kind === 'done' || phase.kind === 'error') && phase.warnings.length > 0 && (
          <details class="warnings">
            <summary>
              {phase.warnings.length} note{phase.warnings.length === 1 ? '' : 's'}
            </summary>
            <ul>
              {phase.warnings.slice(0, 50).map((w) => (
                <li>{w}</li>
              ))}
            </ul>
          </details>
        )}
      </section>
    </div>
  );
}
