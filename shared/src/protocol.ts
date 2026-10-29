/**
 * Wire protocol v1 between the Figma plugin UI (client) and the AE panel bridge (server).
 * See PLAN.md §2. Text frames carry JSON messages; binary frames carry assets.
 *
 * Binary asset frame layout:  [u32 BE headerLength][header JSON (utf-8)][payload bytes]
 */
import type { AssetInfo, BuildResult, F2AEDocument } from './schema';

/** Ports the server tries in order; the client scans the same list. */
export const BRIDGE_PORTS: readonly number[] = [7741, 7742, 7743, 7744, 7745];

export const LIMITS = {
  /** max single WebSocket frame */
  maxFrameBytes: 256 * 1024 * 1024,
  /** max asset header JSON */
  maxAssetHeaderBytes: 4096,
  /** builds waiting behind the running one */
  maxQueuedBuilds: 4,
  /** server drops sockets silent for this long */
  idleTimeoutMs: 30_000,
  /** client heartbeat */
  heartbeatMs: 10_000,
  /** client waits this long for sync.result */
  syncTimeoutMs: 180_000,
  /** server aborts a sync that never commits */
  syncAssemblyTimeoutMs: 120_000,
  maxAssetsPerSync: 10_000,
  maxNodes: 200_000,
  maxDepth: 512,
} as const;

export const ALLOWED_ORIGINS: readonly string[] = ['null', 'https://www.figma.com', 'https://figma.com'];

const HASH_RE = /^[a-f0-9]{8,64}$/;
const SYNC_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

export function isValidHash(h: unknown): h is string {
  return typeof h === 'string' && HASH_RE.test(h);
}

export function isValidSyncId(id: unknown): id is string {
  return typeof id === 'string' && SYNC_ID_RE.test(id);
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined || origin === '') return true; // non-browser local tooling
  return ALLOWED_ORIGINS.indexOf(origin) !== -1;
}

// ────────────────────────────── Messages ──────────────────────────────

export interface HelloMsg {
  type: 'hello';
  protocol: number;
  client: 'figma' | 'cli' | 'test';
  clientVersion: string;
}

export interface PingMsg {
  type: 'ping';
  t: number;
}

export interface SyncBeginMsg {
  type: 'sync.begin';
  syncId: string;
  assets: Pick<AssetInfo, 'hash' | 'mime' | 'byteLength'>[];
}

export interface SyncCommitMsg {
  type: 'sync.commit';
  syncId: string;
  document: F2AEDocument;
}

export type ClientMessage = HelloMsg | PingMsg | SyncBeginMsg | SyncCommitMsg;

export interface WelcomeMsg {
  type: 'welcome';
  protocol: number;
  serverVersion: string;
  host: { app: string; version: string };
}

export interface PongMsg {
  type: 'pong';
  t: number;
}

export interface SyncNeedMsg {
  type: 'sync.need';
  syncId: string;
  hashes: string[];
}

export type SyncPhase = 'received' | 'queued' | 'building';

export interface SyncProgressMsg {
  type: 'sync.progress';
  syncId: string;
  phase: SyncPhase;
  /** position in the build queue when phase === 'queued' */
  position?: number;
}

export interface SyncResultMsg extends BuildResult {
  type: 'sync.result';
  syncId: string;
}

export type ErrorCode =
  | 'BAD_MESSAGE'
  | 'PROTOCOL_MISMATCH'
  | 'NOT_READY'
  | 'BUSY'
  | 'UNKNOWN_SYNC'
  | 'INVALID_DOCUMENT'
  | 'ASSET_MISSING'
  | 'TIMEOUT'
  | 'HOST_ERROR';

export interface ErrorMsg {
  type: 'error';
  code: ErrorCode;
  message: string;
  syncId?: string;
}

export type ServerMessage = WelcomeMsg | PongMsg | SyncNeedMsg | SyncProgressMsg | SyncResultMsg | ErrorMsg;

export interface AssetFrameHeader {
  syncId: string;
  hash: string;
  mime: string;
}

// ────────────────────────────── Parsing ───────────────────────────────

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

function fail<T>(error: string): ParseOutcome<T> {
  return { ok: false, error };
}

/** Structural validation of an inbound client JSON frame (server side). */
export function parseClientMessage(raw: string): ParseOutcome<ClientMessage> {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return fail('invalid JSON');
  }
  if (typeof m !== 'object' || m === null) return fail('message must be an object');
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case 'hello':
      if (typeof o.protocol !== 'number') return fail('hello.protocol must be a number');
      if (typeof o.clientVersion !== 'string') return fail('hello.clientVersion must be a string');
      return { ok: true, value: o as unknown as HelloMsg };
    case 'ping':
      return { ok: true, value: { type: 'ping', t: typeof o.t === 'number' ? o.t : 0 } };
    case 'sync.begin': {
      if (!isValidSyncId(o.syncId)) return fail('sync.begin.syncId invalid');
      if (!Array.isArray(o.assets)) return fail('sync.begin.assets must be an array');
      if (o.assets.length > LIMITS.maxAssetsPerSync) return fail('too many assets');
      for (const a of o.assets as unknown[]) {
        const ao = a as Record<string, unknown>;
        if (typeof a !== 'object' || a === null || !isValidHash(ao.hash)) return fail('asset hash invalid');
        if (typeof ao.byteLength !== 'number' || ao.byteLength < 0) return fail('asset byteLength invalid');
      }
      return { ok: true, value: o as unknown as SyncBeginMsg };
    }
    case 'sync.commit':
      if (!isValidSyncId(o.syncId)) return fail('sync.commit.syncId invalid');
      if (typeof o.document !== 'object' || o.document === null) return fail('sync.commit.document missing');
      return { ok: true, value: o as unknown as SyncCommitMsg };
    default:
      return fail(`unknown message type: ${String(o.type)}`);
  }
}

// ───────────────────────────── Asset frames ───────────────────────────

const textEncoder = /* @__PURE__ */ new TextEncoder();
const textDecoder = /* @__PURE__ */ new TextDecoder();

export function encodeAssetFrame(header: AssetFrameHeader, bytes: Uint8Array): Uint8Array {
  const h = textEncoder.encode(JSON.stringify(header));
  const out = new Uint8Array(4 + h.length + bytes.length);
  new DataView(out.buffer).setUint32(0, h.length, false);
  out.set(h, 4);
  out.set(bytes, 4 + h.length);
  return out;
}

export function decodeAssetFrame(buf: Uint8Array): ParseOutcome<{ header: AssetFrameHeader; bytes: Uint8Array }> {
  if (buf.length < 4) return fail('asset frame too short');
  const len = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(0, false);
  if (len === 0 || len > LIMITS.maxAssetHeaderBytes || 4 + len > buf.length) return fail('asset header length invalid');
  let header: AssetFrameHeader;
  try {
    header = JSON.parse(textDecoder.decode(buf.subarray(4, 4 + len))) as AssetFrameHeader;
  } catch {
    return fail('asset header is not JSON');
  }
  if (!isValidSyncId(header.syncId)) return fail('asset header syncId invalid');
  if (!isValidHash(header.hash)) return fail('asset header hash invalid');
  return { ok: true, value: { header, bytes: buf.subarray(4 + len) } };
}

/** Collision-resistant enough for sync ids (not a security token). */
export function newSyncId(): string {
  const r = Math.random().toString(36).slice(2, 10);
  return `s${Date.now().toString(36)}${r}`;
}
