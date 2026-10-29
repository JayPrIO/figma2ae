/**
 * ExtendScript entry point. Installs `F2AE` on $.global (idempotent: the panel may evaluate
 * this file more than once, e.g. after a panel reload).
 *
 *   F2AE.ping()                   → '{"ok":true,"version":…,"ae":…}'
 *   F2AE.buildFromFile(jobPath)   → BuildResult JSON. Job file: {document, assetPaths}
 *
 * Every entry point returns a JSON string and never throws across the CEP boundary.
 */
import { PRODUCT_VERSION } from '@f2ae/shared/version';
import type { BuildResult, F2AEDocument } from '@f2ae/shared/schema';
import { buildDocument } from './build';
import { nowMs, parseJson, readTextFile, stringify } from './util';

interface Job {
  document: F2AEDocument;
  assetPaths: { [hash: string]: string };
}

function failure(message: string, t0: number): string {
  var r: BuildResult = { ok: false, stats: { comps: 0, layers: 0, nodes: 0, durationMs: nowMs() - t0 }, warnings: [], error: message };
  return stringify(r);
}

function ping(): string {
  return stringify({ ok: true, version: PRODUCT_VERSION, ae: String(app.version), project: !!app.project });
}

function buildFromFile(path: string): string {
  var t0 = nowMs();
  try {
    if (!app.project) app.newProject();
    var job = parseJson(readTextFile(path)) as Job;
    if (!job || !job.document) return failure('job file has no document', t0);
    return stringify(buildDocument(job.document, job.assetPaths || {}));
  } catch (e) {
    var line = e && (e as any).line ? ' (line ' + (e as any).line + ')' : '';
    return failure(String(e) + line, t0);
  }
}

$.global.F2AE = { version: PRODUCT_VERSION, ping: ping, buildFromFile: buildFromFile };
