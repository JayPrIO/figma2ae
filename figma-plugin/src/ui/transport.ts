/**
 * Resilient WebSocket client for the AE bridge.
 *  - Scans BRIDGE_PORTS with a per-attempt connect timeout.
 *  - hello/welcome handshake with timeout; protocol mismatch is surfaced, not retried hot.
 *  - Reconnects with exponential backoff + full jitter (250 ms → 8 s).
 *  - Application heartbeat; a missed pong window forces a reconnect (half-open detection).
 *  - Each sync has its own deadline; in-flight syncs fail fast when the socket drops.
 * Environment-agnostic: takes a WebSocket constructor (browser in Figma, `ws` in tests).
 */
import {
  BRIDGE_PORTS,
  encodeAssetFrame,
  LIMITS,
  newSyncId,
  type ServerMessage,
  type SyncPhase,
  type SyncResultMsg,
  type WelcomeMsg,
} from '@f2ae/shared/protocol';
import type { F2AEDocument } from '@f2ae/shared/schema';
import { PROTOCOL_VERSION } from '@f2ae/shared/version';

export interface WebSocketLike {
  readonly readyState: number;
  binaryType: string;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'disconnected';

export interface ConnectionStatus {
  state: ConnectionState;
  port?: number;
  host?: WelcomeMsg['host'];
  serverVersion?: string;
  attempt: number;
  retryInMs?: number;
  lastError?: string;
}

export interface SyncAsset {
  hash: string;
  mime: string;
  bytes: Uint8Array;
}

export interface SyncProgress {
  phase: SyncPhase | 'uploading';
  position?: number;
  uploaded?: number;
  total?: number;
}

export class SyncError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface BridgeClientOptions {
  WebSocket: WebSocketCtor;
  clientVersion: string;
  ports?: readonly number[];
  hostname?: string;
  connectTimeoutMs?: number;
  handshakeTimeoutMs?: number;
  heartbeatMs?: number;
  syncTimeoutMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  random?: () => number;
  onStatus?: (s: ConnectionStatus) => void;
}

interface PendingSync {
  assets: Map<string, SyncAsset>;
  document: F2AEDocument;
  onProgress?: (p: SyncProgress) => void;
  resolve: (r: SyncResultMsg) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const OPEN = 1;

export class BridgeClient {
  private ws: WebSocketLike | null = null;
  private status: ConnectionStatus = { state: 'idle', attempt: 0 };
  private stopped = true;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private hbTimer: ReturnType<typeof setInterval> | null = null;
  private lastPong = 0;
  private readonly pending = new Map<string, PendingSync>();
  private readonly o: Required<Omit<BridgeClientOptions, 'onStatus'>> & Pick<BridgeClientOptions, 'onStatus'>;

  constructor(opts: BridgeClientOptions) {
    this.o = {
      ports: BRIDGE_PORTS,
      hostname: 'localhost',
      connectTimeoutMs: 1500,
      handshakeTimeoutMs: 3000,
      heartbeatMs: LIMITS.heartbeatMs,
      syncTimeoutMs: LIMITS.syncTimeoutMs,
      backoffMinMs: 250,
      backoffMaxMs: 8000,
      random: Math.random,
      ...opts,
    };
  }

  get connection(): ConnectionStatus {
    return this.status;
  }

  get connected(): boolean {
    return this.status.state === 'connected';
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.connectLoop();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown(new SyncError('CLOSED', 'client stopped'));
    this.setStatus({ state: 'idle', attempt: 0 });
  }

  /** Skip the current backoff and try immediately (e.g. user pressed "Retry"). */
  retryNow(): void {
    if (this.stopped || this.status.state === 'connected' || this.status.state === 'connecting') return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    void this.connectLoop();
  }

  private setStatus(s: ConnectionStatus): void {
    this.status = s;
    this.o.onStatus?.(s);
  }

  // ───────────────────────────── connection ─────────────────────────────

  private async connectLoop(): Promise<void> {
    const attempt = this.status.attempt + 1;
    this.setStatus({ state: 'connecting', attempt });
    let lastError = 'After Effects panel not reachable';
    for (const port of this.o.ports) {
      if (this.stopped) return;
      try {
        const { ws, welcome } = await this.tryPort(port);
        if (this.stopped) {
          ws.close();
          return;
        }
        this.adopt(ws, port, welcome);
        return;
      } catch (e) {
        lastError = (e as Error).message;
        if (e instanceof SyncError && e.code === 'PROTOCOL_MISMATCH') break;
      }
    }
    this.scheduleRetry(attempt, lastError);
  }

  private scheduleRetry(attempt: number, lastError: string): void {
    if (this.stopped) return;
    const cap = Math.min(this.o.backoffMaxMs, this.o.backoffMinMs * 2 ** Math.min(attempt, 10));
    const delay = Math.max(this.o.backoffMinMs, Math.round(this.o.random() * cap));
    this.setStatus({ state: 'disconnected', attempt, retryInMs: delay, lastError });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connectLoop();
    }, delay);
  }

  private tryPort(port: number): Promise<{ ws: WebSocketLike; welcome: WelcomeMsg }> {
    return new Promise((resolve, reject) => {
      let ws: WebSocketLike;
      try {
        ws = new this.o.WebSocket(`ws://${this.o.hostname}:${port}`);
      } catch (e) {
        reject(e as Error);
        return;
      }
      ws.binaryType = 'arraybuffer';
      let settled = false;
      const done = (err: Error | null, welcome?: WelcomeMsg): void => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        clearTimeout(handshakeTimer);
        if (err) {
          ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          reject(err);
        } else resolve({ ws, welcome: welcome! });
      };
      let handshakeTimer: ReturnType<typeof setTimeout> | undefined;
      const connectTimer = setTimeout(() => done(new Error(`port ${port}: connect timeout`)), this.o.connectTimeoutMs);
      ws.onerror = () => done(new Error(`port ${port}: unreachable`));
      ws.onclose = () => done(new Error(`port ${port}: closed during handshake`));
      ws.onopen = () => {
        clearTimeout(connectTimer);
        handshakeTimer = setTimeout(() => done(new Error(`port ${port}: handshake timeout`)), this.o.handshakeTimeoutMs);
        ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, client: 'figma', clientVersion: this.o.clientVersion }));
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        let m: ServerMessage;
        try {
          m = JSON.parse(ev.data) as ServerMessage;
        } catch {
          return;
        }
        if (m.type === 'welcome') done(null, m);
        else if (m.type === 'error' && m.code === 'PROTOCOL_MISMATCH') done(new SyncError(m.code, m.message));
      };
    });
  }

  private adopt(ws: WebSocketLike, port: number, welcome: WelcomeMsg): void {
    this.ws = ws;
    this.lastPong = Date.now();
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onerror = () => undefined;
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.teardown(new SyncError('DISCONNECTED', 'connection to After Effects was lost'));
      this.scheduleRetry(0, 'connection lost');
    };
    this.hbTimer = setInterval(() => this.heartbeat(), this.o.heartbeatMs);
    this.setStatus({ state: 'connected', port, host: welcome.host, serverVersion: welcome.serverVersion, attempt: 0 });
  }

  private heartbeat(): void {
    const ws = this.ws;
    if (!ws) return;
    if (Date.now() - this.lastPong > this.o.heartbeatMs * 2.5) {
      // half-open socket: force reconnect
      ws.close(4001, 'heartbeat timeout');
      ws.onclose?.({});
      return;
    }
    if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'ping', t: Date.now() }));
  }

  private teardown(reason: Error): void {
    if (this.hbTimer) clearInterval(this.hbTimer);
    this.hbTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(reason);
      this.pending.delete(id);
    }
  }

  // ─────────────────────────────── messages ───────────────────────────────

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let m: ServerMessage;
    try {
      m = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }
    this.lastPong = Date.now(); // any traffic proves liveness
    switch (m.type) {
      case 'pong':
      case 'welcome':
        return;
      case 'sync.need':
        return this.uploadAndCommit(m.syncId, m.hashes);
      case 'sync.progress':
        this.pending.get(m.syncId)?.onProgress?.({ phase: m.phase, position: m.position });
        return;
      case 'sync.result': {
        const p = this.pending.get(m.syncId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(m.syncId);
        p.resolve(m);
        return;
      }
      case 'error': {
        const p = m.syncId ? this.pending.get(m.syncId) : undefined;
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(m.syncId!);
        p.reject(new SyncError(m.code, m.message));
        return;
      }
    }
  }

  private uploadAndCommit(syncId: string, hashes: string[]): void {
    const p = this.pending.get(syncId);
    const ws = this.ws;
    if (!p || !ws) return;
    const total = hashes.length;
    let uploaded = 0;
    for (const h of hashes) {
      const a = p.assets.get(h);
      if (!a) continue; // server asked for something we never offered: it will report ASSET_MISSING
      ws.send(encodeAssetFrame({ syncId, hash: h, mime: a.mime }, a.bytes));
      uploaded++;
      p.onProgress?.({ phase: 'uploading', uploaded, total });
    }
    ws.send(JSON.stringify({ type: 'sync.commit', syncId, document: p.document }));
  }

  /** Sends a document (+ content-addressed assets). Resolves with the AE build result. */
  sync(document: F2AEDocument, assets: SyncAsset[], onProgress?: (p: SyncProgress) => void): Promise<SyncResultMsg> {
    const ws = this.ws;
    if (!ws || ws.readyState !== OPEN || !this.connected) {
      return Promise.reject(new SyncError('NOT_CONNECTED', 'After Effects is not connected'));
    }
    const syncId = newSyncId();
    return new Promise<SyncResultMsg>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(syncId);
        reject(new SyncError('TIMEOUT', 'After Effects did not finish in time'));
      }, this.o.syncTimeoutMs);
      this.pending.set(syncId, {
        assets: new Map(assets.map((a) => [a.hash, a])),
        document,
        onProgress,
        resolve,
        reject,
        timer,
      });
      ws.send(
        JSON.stringify({
          type: 'sync.begin',
          syncId,
          assets: assets.map((a) => ({ hash: a.hash, mime: a.mime, byteLength: a.bytes.byteLength })),
        }),
      );
    });
  }
}
