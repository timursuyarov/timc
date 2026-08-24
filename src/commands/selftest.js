import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `timc selftest` — the acceptance tests for the invariants:
 * cold start, kill mid-step, fake report, orchestrator deny, rebuild.
 */
export async function selftest({ args }) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..', '..');
  const target = args.positional[0] ? [`test/${args.positional[0]}.test.js`] : [];
  const res = spawnSync(process.execPath, ['--test', ...target], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  return res.status === null ? 1 : res.status;
}

export default selftest;
