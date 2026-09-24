import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `timc selftest` — the acceptance tests for the invariants:
 * cold start, kill mid-step, fake report, orchestrator deny, rebuild.
 */
export async function selftest({ args }) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.resolve(here, '..', '..');
  // Name the test files: a bare `node --test` would also run test/fixtures/*, whose fake servers never exit.
  const target = args.positional[0]
    ? [`test/${args.positional[0]}.test.js`]
    : fs.readdirSync(path.join(root, 'test')).filter((f) => f.endsWith('.test.js')).map((f) => `test/${f}`);
  const res = spawnSync(process.execPath, ['--test', ...target], {
    cwd: root,
    stdio: 'inherit',
    windowsHide: true,
  });
  return res.status === null ? 1 : res.status;
}

export default selftest;
