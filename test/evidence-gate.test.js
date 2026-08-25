import test from 'node:test';
import assert from 'node:assert/strict';
import { bashHookPayload, cleanup, makeRepo, timc } from './helpers.js';

/**
 * Invariant 13: status changes only on machine-checked evidence.
 * These are the concrete ways a agent report could lie, and each must fail.
 */
async function ready(t, name) {
  const repo = makeRepo(name);
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'fix label typo', '--json']);
  timc(repo, ['phase', 'advance']);
  timc(repo, ['step', 'add', '--goal', 'a', '--delivers', 'the label renders correctly', '--touches', 'src/**', '--validate', 'node --version']);
  timc(repo, ['step', 'start', 'IMP-001']);
  return repo;
}

test('echoing the command is not evidence', async (t) => {
  const repo = await ready(t, 'ev-echo');
  timc(repo, ['record', '--hook'], { stdin: bashHookPayload('echo "node --version"', { cwd: repo }) });
  const res = timc(repo, ['step', 'complete', 'IMP-001']);
  assert.equal(res.code, 2);
  assert.match(res.err, /not the expected command|no evidence/i);
});

test('a laundered exit code is not evidence', async (t) => {
  const repo = await ready(t, 'ev-launder');
  // Really runs, really exits 0 — but the operator could be hiding a failure.
  const ran = timc(repo, ['run', '--', 'node --version || true']);
  assert.equal(ran.code, 0);
  const res = timc(repo, ['step', 'complete', 'IMP-001']);
  assert.equal(res.code, 2, 'exit-code laundering must not close a step');
  assert.match(res.err, /shell operators/i);
});

test('a failing command is recorded and still blocks the step', async (t) => {
  const repo = await ready(t, 'ev-fail');
  const ran = timc(repo, ['run', '--step', 'IMP-001', '--', 'node --version --this-flag-does-not-exist']);
  assert.notEqual(ran.code, 0, 'timc run mirrors the real exit code');
  const res = timc(repo, ['step', 'complete', 'IMP-001']);
  assert.equal(res.code, 2);
  assert.match(res.err, /ran but failed|no evidence/i);
});

test('evidence from before the step started does not count', async (t) => {
  const repo = makeRepo('ev-stale');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'fix label typo', '--json']);
  timc(repo, ['phase', 'advance']);
  timc(repo, ['step', 'add', '--goal', 'a', '--delivers', 'the label renders correctly', '--touches', 'src/**', '--validate', 'node --version']);
  // run first, start second
  timc(repo, ['run', '--', 'node --version']);
  await new Promise((r) => setTimeout(r, 1100)); // timestamps have second precision
  timc(repo, ['step', 'start', 'IMP-001']);
  const res = timc(repo, ['step', 'complete', 'IMP-001']);
  assert.equal(res.code, 2);
  assert.match(res.err, /before the step started/i);
});

test('the hook path also produces valid evidence', async (t) => {
  const repo = await ready(t, 'ev-hook');
  const rec = timc(repo, ['record', '--hook'], { stdin: bashHookPayload('node --version', { cwd: repo }) });
  assert.equal(rec.code, 0, rec.err);
  const res = timc(repo, ['step', 'complete', 'IMP-001', '--json']);
  assert.equal(res.code, 0, res.err);
  assert.equal(res.json.evidence.length, 1);
});

test('a failed hook run is recorded as a failure', async (t) => {
  const repo = await ready(t, 'ev-hookfail');
  timc(repo, ['record', '--hook', '--failed'], { stdin: bashHookPayload('node --version', { cwd: repo, failed: true }) });
  const res = timc(repo, ['step', 'complete', 'IMP-001']);
  assert.equal(res.code, 2);
});
