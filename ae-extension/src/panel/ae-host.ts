/**
 * BuildHost implementation that drives the ExtendScript builder.
 *
 * Large documents never travel through evalScript's string argument (slow, size-limited):
 * the job is written to a temp file and only its path crosses the CEP boundary.
 */
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BuildHost, BuildJob, Logger } from '@f2ae/bridge-server';
import type { BuildResult } from '@f2ae/shared/schema';
import { EVAL_ERROR, type Cep } from './cep';

export interface AeHostOptions {
  cep: Cep;
  jobsDir: string;
  /** absolute path of f2ae.jsx (re-evaluated if the engine lost F2AE, e.g. after a panel reload) */
  jsxPath: string;
  logger: Logger;
  evalTimeoutMs?: number;
}

/**
 * JSON.stringify leaves U+2028/U+2029 unescaped; they are line terminators inside ES3 string
 * literals and would break the ExtendScript eval fallback. Escape them.
 */
export function toExtendScriptJson(v: unknown): string {
  return JSON.stringify(v).replace(/[\u2028\u2029]/g, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'));
}

/** Quotes a string for safe embedding in an ExtendScript call. */
export function esString(s: string): string {
  return toExtendScriptJson(s);
}

function failed(error: string): BuildResult {
  return { ok: false, stats: { comps: 0, layers: 0, nodes: 0, durationMs: 0 }, warnings: [], error };
}

export class AeBuildHost implements BuildHost {
  private seq = 0;
  constructor(private readonly o: AeHostOptions) {}

  info(): { app: string; version: string } {
    return { app: 'After Effects', version: this.o.cep.hostVersion() };
  }

  /** Ensures the F2AE namespace exists in the ExtendScript engine. */
  async ensureLoaded(): Promise<string> {
    const t = await this.o.cep.evalScript('typeof F2AE === "object" ? F2AE.version : "missing"', 10_000);
    if (t !== 'missing' && t !== EVAL_ERROR) return t;
    this.o.logger.warn('F2AE not loaded in ExtendScript; evaluating jsx', { jsx: this.o.jsxPath });
    const r = await this.o.cep.evalScript(`$.evalFile(${esString(this.o.jsxPath)}); F2AE.version`, 30_000);
    if (r === EVAL_ERROR) throw new Error('failed to load f2ae.jsx into After Effects');
    return r;
  }

  async build(job: BuildJob): Promise<BuildResult> {
    await mkdir(this.o.jobsDir, { recursive: true });
    const file = join(this.o.jobsDir, `${job.syncId}-${++this.seq}.json`);
    await writeFile(file, toExtendScriptJson({ document: job.document, assetPaths: job.assetPaths }), 'utf8');
    try {
      await this.ensureLoaded();
      const raw = await this.o.cep.evalScript(`F2AE.buildFromFile(${esString(file)})`, this.o.evalTimeoutMs ?? 170_000);
      if (raw === EVAL_ERROR || !raw) return failed('ExtendScript raised an error (see ~/Library/Logs/Figma2AE)');
      try {
        return JSON.parse(raw) as BuildResult;
      } catch {
        return failed(`unexpected ExtendScript result: ${raw.slice(0, 200)}`);
      }
    } finally {
      await unlink(file).catch(() => undefined);
    }
  }
}
