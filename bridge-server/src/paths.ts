import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/** macOS-conventional locations (falls back sensibly elsewhere for CI). */
export function defaultPaths(): { cache: string; logs: string; jobs: string } {
  const home = homedir();
  const mac = process.platform === 'darwin';
  return {
    cache: mac ? join(home, 'Library', 'Caches', 'Figma2AE', 'assets') : join(home, '.cache', 'figma2ae', 'assets'),
    logs: mac ? join(home, 'Library', 'Logs', 'Figma2AE') : join(home, '.local', 'state', 'figma2ae'),
    jobs: join(tmpdir(), 'figma2ae-jobs'),
  };
}
