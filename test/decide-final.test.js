import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, eventTypes, git, makeRepo, timc } from './helpers.js';

const taskDir = (repo, slug) => path.join(repo, '.timc', 'tasks', slug);

function trivialTask(t, name) {
  const repo = makeRepo(name);
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'fix label typo', '--json']);
  return repo;
}

test('a decision needs a reason, and a user decision needs the answer behind it', async (t) => {
  const repo = trivialTask(t, 'dec-evidence');

  const noReason = timc(repo, ['decide', 'Which split?', '--decision', 'pro rata']);
  assert.notEqual(noReason.code, 0);
  assert.match(noReason.err, /--reason/);

  // claiming the user decided, without any answer to point at
  const fabricated = timc(repo, ['decide', 'Which split?', '--decision', 'pro rata', '--reason', 'x', '--by', 'user']);
  assert.equal(fabricated.code, 2, 'a user decision cannot be conjured');
  assert.match(fabricated.err, /needs the answer that carries it/i);

  // pointing at a question that was never answered
  timc(repo, ['ask', 'Which split?', '--recommend', 'pro rata']);
  const unanswered = timc(repo, ['decide', 'Which split?', '--decision', 'pro rata', '--reason', 'x', '--by', 'user', '--evidence', 'Q-001']);
  assert.equal(unanswered.code, 2);
  assert.match(unanswered.err, /not been answered/i);

  // pointing at an event that is not an answer
  const wrongEvent = timc(repo, ['decide', 'Which split?', '--decision', 'pro rata', '--reason', 'x', '--by', 'user', '--evidence', 'events#seq=1']);
  assert.equal(wrongEvent.code, 2);
  assert.match(wrongEvent.err, /not an answer from the user/i);

  // the real path
  timc(repo, ['answer', 'Q-001', 'pro rata on the remaining balance']);
  const ok = timc(repo, ['decide', 'Which split?', '--decision', 'pro rata', '--reason', 'matches the bank report', '--by', 'user', '--evidence', 'Q-001', '--json']);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.json.id, 'DEC-001');
  assert.match(ok.json.evidence, /events#seq=\d+/);
  assert.ok(eventTypes(repo).includes('DECISION_RECORDED'));
});

test('decisions.md is generated from task.yaml', async (t) => {
  const repo = trivialTask(t, 'dec-render');
  timc(repo, ['decide', 'Retry policy?', '--decision', '3 attempts with backoff', '--reason', 'the bank rate-limits us', '--type', 'IMPLEMENTATION']);
  const md = fs.readFileSync(path.join(taskDir(repo, 'TASK-001-fix-label-typo'), 'decisions.md'), 'utf8');
  assert.match(md, /## DEC-001 — Retry policy\?/);
  assert.match(md, /3 attempts with backoff/);
  assert.match(md, /the bank rate-limits us/);
  assert.match(md, /by: agent:orchestrator/);
});

test('final.md is generated, and re-rendering keeps the hand-written sections', async (t) => {
  const repo = trivialTask(t, 'final-render');
  timc(repo, ['phase', 'advance']);
  timc(repo, ['step', 'add', '--goal', 'fix label', '--delivers', 'the page shows the corrected label', '--touches', 'src/**', '--validate', 'node --version']);
  timc(repo, ['step', 'start', 'IMP-001']);
  timc(repo, ['run', '--', 'node --version']);
  timc(repo, ['step', 'complete', 'IMP-001']);
  timc(repo, ['decide', 'Rename or keep?', '--decision', 'rename', '--reason', 'the old name misled users']);

  const rendered = timc(repo, ['final', '--render']);
  assert.equal(rendered.code, 0, rendered.err);
  const file = path.join(taskDir(repo, 'TASK-001-fix-label-typo'), 'final.md');
  let md = fs.readFileSync(file, 'utf8');
  assert.match(md, /# TASK-001 — fix label typo/);
  assert.match(md, /the page shows the corrected label/);
  assert.match(md, /DEC-001/);
  assert.match(md, /node --version/, 'testing performed comes from the evidence log');
  assert.match(md, /Rejadan farqlar/);

  // a human fills in the two hand-written sections
  fs.writeFileSync(file, md.replace(
    '_What ended up different from what was planned, and why. Written by a human._',
    'The label was renamed rather than corrected in place.',
  ));

  timc(repo, ['decide', 'Ship in this release?', '--decision', 'yes', '--reason', 'low risk']);
  const again = timc(repo, ['final', '--render']);
  assert.equal(again.code, 0, again.err);
  md = fs.readFileSync(file, 'utf8');
  assert.match(md, /The label was renamed rather than corrected in place\./, 'hand-written text survives a re-render');
  assert.match(md, /DEC-002/, 'the generated part is refreshed');
  assert.equal((md.match(/timc:generated:start/g) ?? []).length, 1);
});

test('final.md reports how the phases were actually reached', async (t) => {
  const repo = makeRepo('final-gates');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'add bank integration webhook', '--json']);
  timc(repo, ['phase', 'set', 'BUILDING', '--force', '--reason', 'demo shortcut']);
  timc(repo, ['final', '--render']);
  const md = fs.readFileSync(path.join(taskDir(repo, 'TASK-001-add-bank-integration-webhook'), 'final.md'), 'utf8');
  assert.match(md, /\| FRAMING \| bypassed \|/, 'a bypassed gate must stay visible in the record');
  assert.match(md, /demo shortcut/);
});

test('the task start ref anchors the diff', async (t) => {
  const repo = trivialTask(t, 'final-ref');
  const ref = git(repo, ['rev-parse', '--verify', '--quiet', 'refs/timc/tasks/TASK-001/start']);
  assert.match(ref, /^[0-9a-f]{40}$/);
  assert.equal(ref, git(repo, ['rev-parse', 'HEAD']));
});

test('DONE is reachable once final.md exists and the work is committed', async (t) => {
  const repo = trivialTask(t, 'final-done');
  timc(repo, ['phase', 'advance']);
  timc(repo, ['step', 'add', '--goal', 'fix label', '--delivers', 'the page shows the corrected label', '--touches', 'src/**', '--validate', 'node --version']);
  timc(repo, ['step', 'start', 'IMP-001']);
  timc(repo, ['run', '--', 'node --version']);
  timc(repo, ['step', 'complete', 'IMP-001']);
  assert.equal(timc(repo, ['phase', 'advance', '--json']).json.to, 'LANDING');

  // the gate points at a command that exists, and the command satisfies it
  const beforeFinal = timc(repo, ['phase', 'advance']);
  assert.equal(beforeFinal.code, 2);
  assert.match(beforeFinal.err, /final\.md is missing/);

  timc(repo, ['final', '--render']);
  const done = timc(repo, ['phase', 'advance', '--json']);
  assert.equal(done.code, 0, done.err);
  assert.equal(done.json.to, 'DONE');
});
