/**
 * Minimal, dependency-free wrapper over the CEP runtime (`window.__adobe_cep__`), replacing
 * Adobe's CSInterface.js. Injectable so the host adapter is testable outside AE.
 */

export interface CepRuntime {
  evalScript(script: string, cb: (result: string) => void): void;
  getSystemPath(kind: string): string;
  getHostEnvironment(): string;
}

export interface Cep {
  evalScript(script: string, timeoutMs?: number): Promise<string>;
  extensionPath(): string;
  hostVersion(): string;
}

export class EvalTimeoutError extends Error {}

/** CEP returns this literal when ExtendScript threw. */
export const EVAL_ERROR = 'EvalScript error.';

export function createCep(rt: CepRuntime): Cep {
  return {
    evalScript(script, timeoutMs = 0) {
      return new Promise((resolve, reject) => {
        let done = false;
        const t = timeoutMs > 0 ? setTimeout(() => !done && ((done = true), reject(new EvalTimeoutError(`ExtendScript call timed out after ${timeoutMs} ms`))), timeoutMs) : null;
        try {
          rt.evalScript(script, (r) => {
            if (done) return;
            done = true;
            if (t) clearTimeout(t);
            resolve(r);
          });
        } catch (e) {
          done = true;
          if (t) clearTimeout(t);
          reject(e as Error);
        }
      });
    },
    extensionPath() {
      let p = decodeURI(rt.getSystemPath('extension'));
      if (p.startsWith('file://')) p = p.slice(7);
      return p;
    },
    hostVersion() {
      try {
        return (JSON.parse(rt.getHostEnvironment()) as { appVersion?: string }).appVersion ?? 'unknown';
      } catch {
        return 'unknown';
      }
    },
  };
}
