import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, eventTypes, git, makeRepo, timc } from './helpers.js';

/** The V0 acceptance scenarios, run against a real throwaway repository. */
test('trivial task: init -> build -> evidence -> close', async (t) => {
  const repo = makeRepo('flow-trivial');
  t.after(() => cleanup(repo));

  // --- init -------------------------------------------------------------
  const init = timc(repo, ['init', '--json']);
  assert.equal(init.code, 0, init.err);
  assert.ok(fs.existsSync(path.join(repo, '.timc', 'config', 'project.yaml')));
  assert.ok(fs.existsSync(path.join(repo, '.timc', '.git')), '.timc must be its own repository (D-2)');
  const exclude = fs.readFileSync(path.join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.match(exclude, /\.timc\//, '.timc must be excluded from the code repo locally');
  assert.equal(git(repo, ['status', '--porcelain']), '', 'the code repo must stay clean after init');

  // --- new --------------------------------------------------------------
  const created = timc(repo, ['new', 'fix label typo in reestr', '--json']);
  assert.equal(created.code, 0, created.err);
  assert.equal(created.json.track, 'trivial');
  assert.equal(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main', 'trivial stays on the current branch (D-4)');

  // --- phase ------------------------------------------------------------
  assert.equal(timc(repo, ['phase', 'advance', '--json']).json.to, 'BUILDING');

  // --- step add / start -------------------------------------------------
  const added = timc(repo, ['step', 'add', '--goal', 'fix the label', '--delivers', 'the reestr page shows the corrected label', '--touches', 'src/**', '--validate', 'node --version', '--json']);
  assert.equal(added.code, 0, added.err);
  assert.equal(added.json.id, 'IMP-001');
  assert.equal(timc(repo, ['step', 'start', 'IMP-001']).code, 0);

  // --- closing without evidence must be refused ------------------------
  const premature = timc(repo, ['step', 'complete', 'IMP-001']);
  assert.equal(premature.code, 2, 'a step with no evidence must not close');
  assert.match(premature.err, /evidence/i);
  assert.ok(eventTypes(repo).includes('REPORT_REJECTED'));

  // --- real run, then close --------------------------------------------
  const ran = timc(repo, ['run', '--', 'node', '--version']);
  assert.equal(ran.code, 0, ran.err);
  const closed = timc(repo, ['step', 'complete', 'IMP-001', '--json']);
  assert.equal(closed.code, 0, closed.err);
  assert.equal(closed.json.evidence.length, 1);
  assert.ok(closed.json.checkpoint, 'closing a step creates a checkpoint');

  const status = timc(repo, ['status', '--json']).json;
  assert.equal(status.task.steps[0].status, 'done');
  assert.equal(status.task.progress.pct, 100);
});

test('cold start: a wiped runtime is rebuilt from durable truth', async (t) => {
  const repo = makeRepo('flow-cold');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'fix label typo', '--json']);
  timc(repo, ['phase', 'advance']);
  timc(repo, ['step', 'add', '--goal', 'a', '--delivers', 'the label renders correctly', '--touches', 'src/**', '--validate', 'node --version']);
  timc(repo, ['step', 'start', 'IMP-001']);

  // Simulate a lost machine / wiped cache: runtime is gitignored on purpose.
  fs.rmSync(path.join(repo, '.timc', 'runtime', 'state.json'));

  const rebuilt = timc(repo, ['doctor', '--rebuild', '--json']);
  assert.ok(rebuilt.code === 0 || rebuilt.code === 2, rebuilt.err);
  const state = JSON.parse(fs.readFileSync(path.join(repo, '.timc', 'runtime', 'state.json'), 'utf8'));
  assert.equal(state.phase, 'BUILDING');
  assert.equal(state.currentStep, 'IMP-001');
  assert.ok(state.rebuiltAt);

  const next = timc(repo, ['next', '--json']).json;
  assert.equal(next.step, 'IMP-001');
  assert.equal(next.action, 'validate_step', 'a fresh session must land on validation, not on a fresh start');
});

test('kill mid-step: interrupted work is reported, never silently complete', async (t) => {
  const repo = makeRepo('flow-kill');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'fix label typo', '--json']);
  timc(repo, ['phase', 'advance']);
  timc(repo, ['step', 'add', '--goal', 'edit source', '--delivers', 'the module exports the new constant', '--touches', 'src/**', '--validate', 'node --version']);
  timc(repo, ['step', 'start', 'IMP-001']);

  // work in progress, nothing validated
  fs.appendFileSync(path.join(repo, 'src', 'index.js'), 'export const two = 2;\n');
  const ckpt = timc(repo, ['checkpoint', '--auto', '--json']);
  assert.equal(ckpt.code, 0, ckpt.err);
  assert.ok(ckpt.json.git.stashCommit, 'a dirty worktree is snapshotted without committing to a branch');
  assert.equal(git(repo, ['log', '--oneline']).split('\n').length, 1, 'no bookkeeping commit in the code repo');
  assert.ok(git(repo, ['for-each-ref', 'refs/timc']).includes('refs/timc/checkpoints/'));

  // the session dies here
  fs.rmSync(path.join(repo, '.timc', 'runtime', 'state.json'));

  const resumed = timc(repo, ['resume', '--json']);
  assert.equal(resumed.code, 0, resumed.err);
  assert.equal(resumed.json.phase, 'BUILDING');
  assert.ok(resumed.json.partial.some((p) => p.step === 'IMP-001' && p.kind === 'interrupted_dirty'));
  assert.notEqual(resumed.json.next.action, 'complete_step', 'unvalidated work must never look complete');
});

test('a step marked done without evidence is reopened by resume', async (t) => {
  const repo = makeRepo('flow-reopen');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'fix label typo', '--json']);
  timc(repo, ['phase', 'advance']);
  timc(repo, ['step', 'add', '--goal', 'a', '--delivers', 'the label renders correctly', '--touches', 'src/**', '--validate', 'node --version']);
  timc(repo, ['step', 'start', 'IMP-001']);

  // Tamper with the durable truth the way a hand-edit (or a broken agent) would.
  const taskFile = fs.readdirSync(path.join(repo, '.timc', 'tasks'))
    .filter((d) => d.startsWith('TASK-'))
    .map((d) => path.join(repo, '.timc', 'tasks', d, 'task.yaml'))[0];
  fs.writeFileSync(taskFile, fs.readFileSync(taskFile, 'utf8').replace('status: in_progress', 'status: done'));

  const resumed = timc(repo, ['resume', '--json']);
  assert.equal(resumed.code, 0, resumed.err);
  assert.ok(resumed.json.partial.some((p) => p.kind === 'done_without_evidence'));
  const after = timc(repo, ['status', '--json']).json;
  assert.equal(after.task.steps[0].status, 'needs_fix');
  assert.ok(eventTypes(repo).includes('RECOVERY_STARTED'));
});

test('gates block a standard task until its artifacts exist', async (t) => {
  const repo = makeRepo('flow-gates');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  const created = timc(repo, ['new', 'add bank integration webhook', '--json']);
  assert.equal(created.json.track, 'standard');

  // CREATED -> FRAMING is free; FRAMING -> SPECIFYING needs a real interview.
  assert.equal(timc(repo, ['phase', 'advance', '--json']).json.to, 'FRAMING');
  const blocked = timc(repo, ['phase', 'advance']);
  assert.equal(blocked.code, 2);
  assert.match(blocked.err, /Confirmed facts/, 'an untouched interview template must not pass the gate');

  // Writing real interview content unblocks that check — the gate reads content,
  // not headings — but the design tree must also be worked to an empty frontier.
  const interview = path.join(repo, '.timc', 'tasks', 'TASK-001-add-bank-integration-webhook', 'interview.md');
  fs.writeFileSync(interview, fs.readFileSync(interview, 'utf8')
    .replace('## Confirmed facts\n', '## Confirmed facts\n\n- the webhook is called once per payment\n'));
  const stillOpen = timc(repo, ['phase', 'advance']);
  assert.equal(stillOpen.code, 2);
  assert.match(stillOpen.err, /asked nothing/i);

  timc(repo, ['ask', 'Retry a failed webhook delivery?', '--recommend', 'yes, 3 times with backoff']);
  timc(repo, ['answer', 'Q-001', 'yes, 3 times with backoff']);
  assert.equal(timc(repo, ['phase', 'advance', '--json']).json.to, 'SPECIFYING');

  // A step cannot be started while the task is not in BUILDING.
  const early = timc(repo, ['step', 'start', 'IMP-001']);
  assert.notEqual(early.code, 0);
  assert.ok(eventTypes(repo).includes('GATE_FAILED'));
});
