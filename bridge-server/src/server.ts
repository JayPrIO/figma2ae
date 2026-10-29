/**
 * Figma2AE bridge server: HTTP (health/metrics) + WebSocket (sync protocol v1) bound to
 * loopback only (127.0.0.1 and ::1) on the first free port of BRIDGE_PORTS.
 *
 * Per-connection state machine:
 *   CONNECTED ──hello──▶ READY ──sync.begin──▶ (assets…) ──sync.commit──▶ queued → building → result
 * Multiple syncs per connection are allowed; builds are serialised globally by SerialQueue.
 */
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  BRIDGE_PORTS,
  decodeAssetFrame,
  isAllowedOrigin,
  LIMITS,
  parseClientMessage,
  type ErrorCode,
  type ServerMessage,
  type SyncBeginMsg,
  type SyncCommitMsg,
} from '@f2ae/shared/protocol';
import type { BuildResult, F2AEDocument } from '@f2ae/shared/schema';
import { validateDocument } from '@f2ae/shared/validate';
import { PRODUCT_VERSION, PROTOCOL_VERSION } from '@f2ae/shared/version';
import { AssetIntegrityError, type AssetStore } from './asset-store';
import { JobTimeoutError, QueueFullError, SerialQueue } from './build-queue';
import { nullLogger, type Logger } from './logger';
import { BridgeMetrics } from './metrics';

export interface BuildJob {
  syncId: string;
  document: F2AEDocument;
  /** asset hash → absolute file path */
  assetPaths: Record<string, string>;
}

/** The thing that actually builds (AE panel → ExtendScript, or the CLI file dumper). */
export interface BuildHost {
  info(): { app: string; version: string };
  build(job: BuildJob): Promise<BuildResult>;
}

export interface BridgeServerOptions {
  host: BuildHost;
  assets: AssetStore;
  logger?: Logger;
  ports?: readonly number[];
  /** loopback interfaces to bind; ::1 failures are tolerated */
  bindAddresses?: readonly string[];
  idleTimeoutMs?: number;
  buildTimeoutMs?: number;
  syncAssemblyTimeoutMs?: number;
  maxQueuedBuilds?: number;
}

export interface BridgeEvents {
  listening: [port: number];
  connection: [id: number, origin: string | undefined];
  disconnect: [id: number];
  'sync:queued': [syncId: string, position: number];
  'sync:building': [syncId: string];
  'sync:done': [syncId: string, result: BuildResult];
}

interface PendingSync {
  syncId: string;
  begunAt: number;
  needed: Set<string>;
  hashes: string[];
  /** asset writes still in flight; commit awaits them */
  inflight: Promise<void>[];
  timer: NodeJS.Timeout;
}

interface Conn {
  id: number;
  ws: WebSocket;
  ready: boolean;
  lastSeen: number;
  syncs: Map<string, PendingSync>;
  log: Logger;
}

export class BridgeServer extends EventEmitter<BridgeEvents> {
  readonly metrics = new BridgeMetrics();
  private readonly log: Logger;
  private readonly http: Server[] = [];
  private readonly wss: WebSocketServer;
  private readonly conns = new Map<WebSocket, Conn>();
  private readonly queue: SerialQueue<BuildResult>;
  private sweeper: NodeJS.Timeout | null = null;
  private nextConnId = 1;
  private boundPort = 0;
  private readonly startedAt = Date.now();

  constructor(private readonly opts: BridgeServerOptions) {
    super();
    this.log = opts.logger ?? nullLogger;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrameBytes, perMessageDeflate: false });
    this.queue = new SerialQueue<BuildResult>(
      opts.maxQueuedBuilds ?? LIMITS.maxQueuedBuilds,
      opts.buildTimeoutMs ?? LIMITS.syncTimeoutMs - 5_000,
      (d) => this.metrics.queueDepth.set(d),
    );
  }

  get port(): number {
    return this.boundPort;
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  // ───────────────────────────── lifecycle ─────────────────────────────

  async start(): Promise<number> {
    await this.opts.assets.init();
    const ports = this.opts.ports ?? BRIDGE_PORTS;
    const addrs = this.opts.bindAddresses ?? ['127.0.0.1', '::1'];
    let lastErr: unknown;
    let bound = false;
    for (const port of ports) {
      try {
        await this.bindAll(port, addrs);
        bound = this.http.length > 0;
        if (bound) break;
      } catch (e) {
        lastErr = e;
        await this.closeHttp();
        this.log.warn('port unavailable, trying next', { port, err: (e as Error).message });
      }
    }
    if (!bound) throw new Error(`no free bridge port in [${ports.join(', ')}]: ${(lastErr as Error)?.message}`);
    // resolve the real port when 0 (ephemeral) was requested, e.g. in tests
    const a = this.http[0].address();
    if (a && typeof a === 'object') this.boundPort = a.port;

    const idle = this.opts.idleTimeoutMs ?? LIMITS.idleTimeoutMs;
    this.sweeper = setInterval(() => this.sweep(idle), Math.max(250, Math.min(5_000, idle / 3)));
    this.sweeper.unref();
    this.log.info('bridge listening', { port: this.boundPort, addrs });
    this.emit('listening', this.boundPort);
    return this.boundPort;
  }

  private async bindAll(port: number, addrs: readonly string[]): Promise<void> {
    let primaryPort = port;
    for (let i = 0; i < addrs.length; i++) {
      const srv = createServer((req, res) => this.handleHttp(req, res));
      srv.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
      srv.on('clientError', (_e, socket) => socket.destroy());
      try {
        await new Promise<void>((resolve, reject) => {
          srv.once('error', reject);
          srv.listen({ port: primaryPort, host: addrs[i], exclusive: true }, () => {
            srv.off('error', reject);
            resolve();
          });
        });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        // Secondary addresses (IPv6 loopback) are best-effort.
        if (i > 0 && (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT' || code === 'EADDRINUSE')) {
          this.log.warn('secondary bind failed', { addr: addrs[i], code });
          continue;
        }
        throw e;
      }
      if (i === 0 && port === 0) {
        const a = srv.address();
        if (a && typeof a === 'object') primaryPort = a.port;
      }
      this.http.push(srv);
    }
  }

  private async closeHttp(): Promise<void> {
    await Promise.all(this.http.map((s) => new Promise<void>((r) => s.close(() => r()))));
    this.http.length = 0;
  }

  async stop(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const c of this.conns.values()) {
      for (const s of c.syncs.values()) clearTimeout(s.timer);
      c.ws.close(1001, 'server shutting down');
    }
    this.conns.clear();
    this.wss.close();
    for (const s of this.http) s.closeAllConnections?.();
    await this.closeHttp();
    this.boundPort = 0;
    this.log.info('bridge stopped');
  }

  /**
   * Builds a document that arrived out-of-band (offline `.f2ae.json` bundle import) through the
   * same validation, asset store and serial build queue as live syncs.
   */
  async buildLocal(document: F2AEDocument, assets: { hash: string; mime: string; bytes: Uint8Array }[]): Promise<BuildResult> {
    await this.opts.assets.init();
    for (const a of assets) await this.opts.assets.put(a.hash, a.mime, a.bytes);
    const v = validateDocument(document);
    if (!v.ok) throw new Error(`invalid document: ${v.errors.join('; ')}`);
    const assetPaths: Record<string, string> = {};
    for (const a of document.assets) {
      const rec = this.opts.assets.get(a.hash);
      if (rec) assetPaths[a.hash] = rec.path;
    }
    const syncId = `local${Date.now().toString(36)}`;
    const t0 = Date.now();
    const { result } = this.queue.push(async () => {
      this.emit('sync:building', syncId);
      return this.opts.host.build({ syncId, document, assetPaths });
    });
    const r = await result;
    this.metrics.buildLatency.observe(Date.now() - t0);
    (r.ok ? this.metrics.syncsSucceeded : this.metrics.syncsFailed).inc();
    this.emit('sync:done', syncId, r);
    return r;
  }

  // ─────────────────────────────── HTTP ────────────────────────────────

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = (req.url ?? '/').split('?')[0];
    const send = (status: number, type: string, body: string): void => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (req.method !== 'GET') return send(405, 'text/plain', 'method not allowed');
    if (url === '/health') {
      const host = this.opts.host.info();
      return send(
        200,
        'application/json',
        JSON.stringify({
          ok: true,
          product: 'Figma2AE',
          version: PRODUCT_VERSION,
          protocol: PROTOCOL_VERSION,
          host,
          uptimeMs: Date.now() - this.startedAt,
          metrics: this.metrics.summary(),
        }),
      );
    }
    if (url === '/metrics') return send(200, 'text/plain; version=0.0.4', this.metrics.renderPrometheus());
    send(404, 'text/plain', 'not found');
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) {
      this.metrics.connectionsRejected.inc();
      this.log.warn('rejected upgrade: origin not allowed', { origin });
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, origin));
  }

  // ───────────────────────────── WebSocket ─────────────────────────────

  private onConnection(ws: WebSocket, origin: string | undefined): void {
    const id = this.nextConnId++;
    const conn: Conn = { id, ws, ready: false, lastSeen: Date.now(), syncs: new Map(), log: this.log.child({ conn: id }) };
    this.conns.set(ws, conn);
    this.metrics.connectionsTotal.inc();
    this.metrics.connectionsActive.set(this.conns.size);
    conn.log.info('client connected', { origin });
    this.emit('connection', id, origin);

    ws.on('message', (data, isBinary) => {
      conn.lastSeen = Date.now();
      this.metrics.bytesIn.inc(byteLength(data));
      if (isBinary) this.onAsset(conn, data);
      else this.onText(conn, data.toString());
    });
    ws.on('pong', () => {
      conn.lastSeen = Date.now();
    });
    ws.on('close', () => this.onClose(conn));
    ws.on('error', (e) => conn.log.warn('socket error', { err: e.message }));
  }

  private onClose(conn: Conn): void {
    for (const s of conn.syncs.values()) clearTimeout(s.timer);
    conn.syncs.clear();
    if (this.conns.delete(conn.ws)) {
      this.metrics.connectionsActive.set(this.conns.size);
      conn.log.info('client disconnected');
      this.emit('disconnect', conn.id);
    }
  }

  private sweep(idleMs: number): void {
    const now = Date.now();
    for (const c of this.conns.values()) {
      if (now - c.lastSeen > idleMs) {
        c.log.warn('dropping idle connection', { idleMs: now - c.lastSeen });
        c.ws.terminate();
        this.onClose(c);
      } else if (now - c.lastSeen > idleMs / 2) {
        // nudge: ws-level ping; pong refreshes lastSeen
        try {
          c.ws.ping();
        } catch {
          /* socket already closing */
        }
      }
    }
  }

  private send(conn: Conn, msg: ServerMessage): void {
    if (conn.ws.readyState !== conn.ws.OPEN) return;
    conn.ws.send(JSON.stringify(msg));
  }

  private fail(conn: Conn, code: ErrorCode, message: string, syncId?: string): void {
    if (code === 'BAD_MESSAGE' || code === 'NOT_READY' || code === 'UNKNOWN_SYNC') this.metrics.protocolErrors.inc();
    conn.log.warn('client error', { code, message, syncId });
    this.send(conn, { type: 'error', code, message, ...(syncId ? { syncId } : {}) });
  }

  private onText(conn: Conn, raw: string): void {
    const parsed = parseClientMessage(raw);
    if (!parsed.ok) return this.fail(conn, 'BAD_MESSAGE', parsed.error);
    const msg = parsed.value;
    switch (msg.type) {
      case 'hello': {
        if (msg.protocol !== PROTOCOL_VERSION) {
          this.fail(conn, 'PROTOCOL_MISMATCH', `server speaks protocol ${PROTOCOL_VERSION}, client ${msg.protocol}`);
          conn.ws.close(4000, 'protocol mismatch');
          return;
        }
        conn.ready = true;
        conn.log.info('hello', { client: msg.client, clientVersion: msg.clientVersion });
        this.send(conn, {
          type: 'welcome',
          protocol: PROTOCOL_VERSION,
          serverVersion: PRODUCT_VERSION,
          host: this.opts.host.info(),
        });
        return;
      }
      case 'ping':
        this.send(conn, { type: 'pong', t: msg.t });
        return;
      case 'sync.begin':
        if (!conn.ready) return this.fail(conn, 'NOT_READY', 'send hello first');
        return this.onBegin(conn, msg);
      case 'sync.commit':
        if (!conn.ready) return this.fail(conn, 'NOT_READY', 'send hello first');
        return this.onCommit(conn, msg);
    }
  }

  private onBegin(conn: Conn, msg: SyncBeginMsg): void {
    if (conn.syncs.has(msg.syncId)) return this.fail(conn, 'BAD_MESSAGE', 'duplicate syncId', msg.syncId);
    this.metrics.syncsStarted.inc();
    const hashes = msg.assets.map((a) => a.hash);
    const missing = this.opts.assets.missing(hashes);
    this.metrics.assetsDeduped.inc(hashes.length - missing.length);
    const timeout = this.opts.syncAssemblyTimeoutMs ?? LIMITS.syncAssemblyTimeoutMs;
    const timer = setTimeout(() => {
      if (conn.syncs.delete(msg.syncId)) {
        this.metrics.syncsFailed.inc();
        this.fail(conn, 'TIMEOUT', 'sync was not committed in time', msg.syncId);
      }
    }, timeout);
    timer.unref();
    conn.syncs.set(msg.syncId, { syncId: msg.syncId, begunAt: Date.now(), needed: new Set(missing), hashes, inflight: [], timer });
    conn.log.info('sync begin', { syncId: msg.syncId, assets: hashes.length, missing: missing.length });
    this.send(conn, { type: 'sync.need', syncId: msg.syncId, hashes: missing });
  }

  private onAsset(conn: Conn, data: RawData): void {
    const buf = toUint8(data);
    const parsed = decodeAssetFrame(buf);
    if (!parsed.ok) return this.fail(conn, 'BAD_MESSAGE', parsed.error);
    const { header, bytes } = parsed.value;
    const sync = conn.syncs.get(header.syncId);
    if (!sync) return this.fail(conn, 'UNKNOWN_SYNC', 'asset for unknown sync', header.syncId);
    if (!sync.needed.has(header.hash)) return; // unrequested or duplicate: ignore (idempotent)
    sync.inflight.push(
      this.opts.assets.put(header.hash, header.mime, bytes).then(
        () => {
          sync.needed.delete(header.hash);
          this.metrics.assetsReceived.inc();
        },
        (e: unknown) => {
          const code: ErrorCode = e instanceof AssetIntegrityError ? 'BAD_MESSAGE' : 'HOST_ERROR';
          this.fail(conn, code, `asset ${header.hash}: ${(e as Error).message}`, header.syncId);
        },
      ),
    );
  }

  private onCommit(conn: Conn, msg: SyncCommitMsg): void {
    const sync = conn.syncs.get(msg.syncId);
    if (!sync) return this.fail(conn, 'UNKNOWN_SYNC', 'commit for unknown sync', msg.syncId);
    conn.syncs.delete(msg.syncId);
    clearTimeout(sync.timer);
    const log = conn.log.child({ syncId: msg.syncId });

    const failSync = (code: ErrorCode, message: string): void => {
      this.metrics.syncsFailed.inc();
      this.fail(conn, code, message, msg.syncId);
    };

    const proceed = (): void => {
      if (sync.needed.size > 0) return failSync('ASSET_MISSING', `missing assets: ${[...sync.needed].slice(0, 5).join(', ')}`);
      const v = validateDocument(msg.document);
      if (!v.ok) return failSync('INVALID_DOCUMENT', v.errors.join('; '));
      this.metrics.receiveLatency.observe(Date.now() - sync.begunAt);
      this.send(conn, { type: 'sync.progress', syncId: msg.syncId, phase: 'received' });
      log.info('sync received', { nodes: v.nodeCount });

      const assetPaths: Record<string, string> = {};
      for (const h of sync.hashes) {
        const a = this.opts.assets.get(h);
        if (a) assetPaths[h] = a.path;
      }
      void this.opts.assets.touch(sync.hashes);

      let queued: ReturnType<SerialQueue<BuildResult>['push']>;
      try {
        queued = this.queue.push(async () => {
          this.send(conn, { type: 'sync.progress', syncId: msg.syncId, phase: 'building' });
          this.emit('sync:building', msg.syncId);
          const t0 = Date.now();
          try {
            return await this.opts.host.build({ syncId: msg.syncId, document: msg.document, assetPaths });
          } finally {
            this.metrics.buildLatency.observe(Date.now() - t0);
          }
        });
      } catch (e) {
        if (e instanceof QueueFullError) return failSync('BUSY', e.message);
        throw e;
      }
      this.send(conn, { type: 'sync.progress', syncId: msg.syncId, phase: 'queued', position: queued.position });
      this.emit('sync:queued', msg.syncId, queued.position);

      queued.result.then(
        (result) => {
          this.metrics.endToEndLatency.observe(Date.now() - sync.begunAt);
          (result.ok ? this.metrics.syncsSucceeded : this.metrics.syncsFailed).inc();
          log.info('sync done', { ok: result.ok, stats: result.stats, warnings: result.warnings.length });
          this.send(conn, { type: 'sync.result', syncId: msg.syncId, ...result });
          this.emit('sync:done', msg.syncId, result);
        },
        (e: unknown) => {
          const timeout = e instanceof JobTimeoutError;
          log.error('build failed', { err: e });
          failSync(timeout ? 'TIMEOUT' : 'HOST_ERROR', (e as Error)?.message ?? String(e));
          this.emit('sync:done', msg.syncId, {
            ok: false,
            stats: { comps: 0, layers: 0, nodes: 0, durationMs: 0 },
            warnings: [],
            error: (e as Error)?.message ?? String(e),
          });
        },
      );
    };

    // Frames are processed in order, so every asset frame of this sync has been seen;
    // only their disk writes may still be in flight.
    if (sync.inflight.length === 0) return proceed();
    void Promise.allSettled(sync.inflight).then(proceed);
  }
}

function byteLength(d: RawData): number {
  if (Array.isArray(d)) return d.reduce((n, b) => n + b.length, 0);
  return (d as ArrayBuffer | Buffer).byteLength;
}

function toUint8(d: RawData): Uint8Array {
  if (Array.isArray(d)) return new Uint8Array(Buffer.concat(d));
  if (d instanceof ArrayBuffer) return new Uint8Array(d);
  return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
}
