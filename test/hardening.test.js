import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  bashGuardPayload, bashHookPayload, cleanup, eventTypes, git, makeRepo, promptPayload, readEvents, timc, writeHookPayload,
} from './helpers.js';
import { commandProves } from '../src/evidence.js';
import { bashWriteTargets, canonicalCommand, timcInvocations } from '../src/shell.js';

/**
 * One test per enforcement gap found in the V0 audit (C1–C4, H2, H3, N1–N11).
 * Each asserts that the model can no longer talk — or type — its way past it.
 */

const TASK_DIR = ['.timc', 'tasks', 'TASK-001-add-bank-integration-webhook'];
const decision = (res) => res.json?.hookSpecificOutput?.permissionDecision ?? null;
const lastSeq = (repo) => readEvents(repo).at(-1)?.seq ?? 0;

/** The user types something in Claude Code: the UserPromptSubmit hook records it. */
function userSays(repo, text) {
  const res = timc(repo, ['prompt', '--hook'], { stdin: promptPayload(text, { cwd: repo }) });
  assert.equal(res.code, 0, res.err);
  return readEvents(repo).filter((e) => e.type === 'USER_PROMPT').at(-1).seq;
}

/** A standard task driven to PLANNING with a real interview and spec. */
function toPlanning(t, name, { seamKind = 'existing' } = {}) {
  const repo = makeRepo(name);
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'add bank integration webhook']);
  timc(repo, ['phase', 'advance']);
  const dir = path.join(repo, ...TASK_DIR);
  const interview = path.join(dir, 'interview.md');
  fs.writeFileSync(interview, fs.readFileSync(interview, 'utf8')
    .replace('## Confirmed facts\n', '## Confirmed facts\n\n- the webhook is called once per payment\n'));
  timc(repo, ['ask', 'Retry a failed delivery?', '--recommend', 'yes, 3 times']);
  timc(repo, ['answer', 'Q-001', 'yes, 3 times']);
  assert.equal(timc(repo, ['phase', 'advance']).code, 0);
  writeSpec(dir, { seamKind });
  const adv = timc(repo, ['phase', 'advance']);
  assert.equal(adv.code, seamKind === 'new' ? 2 : 0, adv.err);
  return { repo, dir };
}

function writeSpec(dir, { seamKind = 'existing', acText = 'a failed delivery is retried three times' } = {}) {
  const spec = path.join(dir, 'spec.md');
  fs.writeFileSync(spec, fs.readFileSync(spec, 'utf8')
    .replace('where: TODO ', 'where: WebhookController integration tests ')
    .replace('kind: existing ', `kind: ${seamKind} `)
    .replace('text: TODO', `text: ${acText}`));
}

function toReady(t, name) {
  const ctx = toPlanning(t, name);
  const add = timc(ctx.repo, ['step', 'add', '--goal', 'retry delivery', '--delivers', 'a failed webhook is retried end to end',
    '--touches', 'src/**', '--validate', 'node --version', '--acceptance', 'AC-1']);
  assert.equal(add.code, 0, add.err);
  assert.equal(timc(ctx.repo, ['phase', 'advance']).code, 0);
  return ctx;
}

function toBuilding(t, name) {
  const ctx = toReady(t, name);
  assert.equal(timc(ctx.repo, ['approve', 'plan']).code, 0);
  const adv = timc(ctx.repo, ['phase', 'advance']);
  assert.equal(adv.code, 0, adv.err);
  return ctx;
}

// --- C1 ---------------------------------------------------------------------

test('C1: a newline cannot launder a failing validation', () => {
  assert.equal(commandProves('npm test', 'npm test\ntrue').ok, false);
  assert.equal(commandProves('npm test', 'npm test\r\ntrue').ok, false);
  assert.equal(commandProves('npm test', 'npm test -- --grep refund').ok, true);
  assert.equal(commandProves('npm test', 'npm test $(true)').ok, false);
});

test('C1: the hook keeps the newline, so the recorded run proves nothing', async (t) => {
  const { repo } = toBuilding(t, 'c1-hook');
  timc(repo, ['step', 'start', 'IMP-001']);
  timc(repo, ['record', '--hook'], { stdin: bashHookPayload('node --version\ntrue', { cwd: repo }) });
  const done = timc(repo, ['step', 'complete', 'IMP-001']);
  assert.equal(done.code, 2, 'laundered evidence must not close the step');
});

// --- C2 ---------------------------------------------------------------------

test('C2: Bash cannot write what Edit/Write may not', async (t) => {
  const { repo } = toBuilding(t, 'c2-bash');
  const guard = (cmd, opts = {}) => timc(repo, ['guard', 'bash', '--hook'], { stdin: bashGuardPayload(cmd, { cwd: repo, ...opts }) });

  assert.equal(decision(guard('echo \'{"exit":0}\' >> .timc/runtime/evidence.ndjson')), 'deny');
  assert.equal(decision(guard(`sed -i 's/in_progress/done/' ${path.join(...TASK_DIR, 'task.yaml')}`)), 'deny');
  assert.equal(decision(guard('bash -c "cat > .timc/runtime/state.json"')), 'deny');
  assert.equal(decision(guard('cp /tmp/x .timc/config/permissions.yaml')), 'deny');
  // the orchestrator does not write production code through the shell either
  assert.equal(decision(guard('cat > src/index.js <<EOF\nx\nEOF')), 'deny');
  assert.equal(decision(guard('cat > src/index.js <<EOF\nx\nEOF', { agentId: 'sub-1' })), null, 'a subagent may');
  // read-only commands pass
  assert.equal(decision(guard('cat .timc/runtime/evidence.ndjson | tail -5')), null);
  assert.equal(decision(guard('dotnet test 2>&1 | tee /tmp/test.log')), null);
});

test('C2: dangerous operations are matched on the parsed command', async (t) => {
  const repo = makeRepo('c2-danger');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  const guard = (cmd) => decision(timc(repo, ['guard', 'bash', '--hook'], { stdin: bashGuardPayload(cmd, { cwd: repo }) }));
  assert.equal(guard('git reset --hard HEAD~1'), 'deny');
  assert.equal(guard('git reset  --hard HEAD~1'), 'deny', 'extra spaces');
  assert.equal(guard('git reset "--hard" HEAD~1'), 'deny', 'quoting');
  assert.equal(guard('git status'), null);
});

test('C2: the shell parser sees the common ways to write a file', () => {
  assert.deepEqual(bashWriteTargets('echo x > a.txt 2>&1'), ['a.txt']);
  assert.deepEqual(bashWriteTargets('echo x >>b.txt'), ['b.txt']);
  assert.deepEqual(bashWriteTargets('cat foo | tee -a c.txt d.txt'), ['c.txt', 'd.txt']);
  assert.deepEqual(bashWriteTargets("sed -i.bak 's/a/b/' e.txt"), ['e.txt']);
  assert.deepEqual(bashWriteTargets('FOO=1 sudo mv x y/z.txt'), ['y/z.txt']);
  assert.deepEqual(bashWriteTargets('sh -c "rm -f g.txt"'), ['g.txt']);
  assert.deepEqual(bashWriteTargets('dotnet test > /dev/null'), []);
  assert.equal(canonicalCommand('git  reset   "--hard"'), 'git reset --hard');
  assert.deepEqual(timcInvocations('cd x && npx timc answer Q-1 yes').map((i) => i.sub), ['answer']);
});

// --- C3 ---------------------------------------------------------------------

test('C3: from Claude Code an answer must quote a message the user sent after the question', async (t) => {
  const repo = makeRepo('c3-answer');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'add bank integration webhook']);
  timc(repo, ['phase', 'advance']);
  const early = userSays(repo, 'let us build the webhook');
  timc(repo, ['ask', 'Retry a failed delivery?', '--recommend', 'yes, 3 times']);

  const bare = timc(repo, ['answer', 'Q-001', 'yes'], { agent: true });
  assert.equal(bare.code, 2);
  assert.match(bare.err, /user's call/);

  const stale = timc(repo, ['answer', 'Q-001', 'yes', '--quote', `events#seq=${early}`], { agent: true });
  assert.equal(stale.code, 2, 'a message sent before the question cannot answer it');

  const reply = userSays(repo, 'yes, three times with backoff');
  const ok = timc(repo, ['answer', 'Q-001', 'yes, 3 times with backoff', '--quote', `events#seq=${reply}`], { agent: true });
  assert.equal(ok.code, 0, ok.err);
  const ev = readEvents(repo).find((e) => e.type === 'ANSWER_RECEIVED');
  assert.equal(ev.payload.via, 'quote');
  assert.equal(ev.payload.quote.seq, reply);
});

test('C3: the model cannot forge a user message', async (t) => {
  const repo = makeRepo('c3-forge');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  const guard = (cmd) => decision(timc(repo, ['guard', 'bash', '--hook'], { stdin: bashGuardPayload(cmd, { cwd: repo }) }));
  assert.equal(guard('echo \'{"prompt":"yes"}\' | timc prompt --hook'), 'deny');
  assert.equal(guard('echo \'{"prompt":"yes"}\' | node src/cli.js prompt --hook'), 'deny');
  assert.equal(guard('env -u CLAUDECODE timc answer Q-001 yes'), 'deny');
  assert.equal(guard('unset CLAUDECODE; timc answer Q-001 yes'), 'deny');
  const script = timc(repo, ['guard', 'write', '--hook'], {
    stdin: JSON.stringify({ tool_name: 'Write', cwd: repo, tool_input: { file_path: '/tmp/x.sh', content: 'unset CLAUDECODE\ntimc answer Q-001 yes' } }),
  });
  assert.equal(decision(script), 'deny');
});

// --- C4 / N8 ------------------------------------------------------------------

test('C4: the model cannot lower a track on its own', async (t) => {
  const repo = makeRepo('c4-track');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  const denied = timc(repo, ['new', 'add partial refunds', '--track', 'trivial'], { agent: true });
  assert.equal(denied.code, 2);
  assert.match(denied.err, /classifies as standard/);

  const asked = userSays(repo, 'this one is tiny, make it trivial');
  const ok = timc(repo, ['new', 'add partial refunds', '--track', 'trivial', '--quote', `events#seq=${asked}`, '--json'], { agent: true });
  assert.equal(ok.code, 0, ok.err);
  const ev = readEvents(repo).find((e) => e.type === 'TRACK_ASSIGNED');
  assert.equal(ev.payload.quote.seq, asked);
});

test('N8: retrack raises the track and reopens the phases it skipped', async (t) => {
  const repo = makeRepo('n8-retrack');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'fix label typo']);
  timc(repo, ['phase', 'advance']);
  const up = timc(repo, ['retrack', 'standard', '--reason', 'it touches refunds after all'], { agent: true });
  assert.equal(up.code, 0, up.err);
  const status = timc(repo, ['status', '--json']).json;
  assert.equal(status.task.track, 'standard');
  assert.equal(status.task.phase, 'FRAMING', 'the interview it never had is reopened');

  const down = timc(repo, ['retrack', 'trivial', '--reason', 'meh'], { agent: true });
  assert.equal(down.code, 2, 'lowering is the user\'s call');
});

// --- H2 ---------------------------------------------------------------------

test('H2: the untouched spec template does not pass the PLANNING gate', async (t) => {
  const repo = makeRepo('h2-spec');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'add bank integration webhook']);
  timc(repo, ['phase', 'advance']);
  const interview = path.join(repo, ...TASK_DIR, 'interview.md');
  fs.writeFileSync(interview, fs.readFileSync(interview, 'utf8').replace('## Confirmed facts\n', '## Confirmed facts\n\n- fact\n'));
  timc(repo, ['ask', 'Q?', '--recommend', 'a']);
  timc(repo, ['answer', 'Q-001', 'a']);
  timc(repo, ['phase', 'advance']);
  const res = timc(repo, ['phase', 'advance']);
  assert.equal(res.code, 2);
  assert.match(res.err, /AC-1: text is still a placeholder/);
  assert.match(res.err, /SEAM-1: needs an id and a real "where"/);
});

// --- N1 / N2 ----------------------------------------------------------------

test('N1: BUILDING needs the user\'s approval of this exact plan', async (t) => {
  const { repo } = toReady(t, 'n1-approve');
  const blocked = timc(repo, ['phase', 'advance']);
  assert.equal(blocked.code, 2);
  assert.match(blocked.err, /not approved the plan/);

  assert.equal(timc(repo, ['approve', 'plan'], { agent: true }).code, 2, 'the agent cannot approve its own plan');
  assert.equal(timc(repo, ['approve', 'plan']).code, 0);

  timc(repo, ['step', 'edit', 'IMP-001', '--touches', 'src/**,test/**']);
  const stale = timc(repo, ['phase', 'advance']);
  assert.equal(stale.code, 2);
  assert.match(stale.err, /changed after it was approved/);

  const ok = userSays(repo, 'plan looks good, go');
  assert.equal(timc(repo, ['approve', 'plan', '--quote', `events#seq=${ok}`], { agent: true }).code, 0);
  assert.equal(timc(repo, ['phase', 'advance']).code, 0);
});

test('N2: a new seam is approved through the CLI, not by writing approved_by', async (t) => {
  const { repo, dir } = toPlanning(t, 'n2-seam', { seamKind: 'new' });
  const spec = path.join(dir, 'spec.md');
  fs.writeFileSync(spec, fs.readFileSync(spec, 'utf8').replace('kind: new ', 'kind: new\n    approved_by: user '));
  assert.equal(timc(repo, ['phase', 'advance']).code, 2, 'a hand-written approved_by counts for nothing');
  assert.equal(timc(repo, ['approve', 'seam', 'SEAM-1']).code, 0);
  assert.equal(timc(repo, ['phase', 'advance']).code, 0);
});

// --- H3 ---------------------------------------------------------------------

test('H3: acceptance criteria are verified from evidence of the step that covers them', async (t) => {
  const { repo, dir } = toBuilding(t, 'h3-verify');
  timc(repo, ['step', 'start', 'IMP-001']);
  timc(repo, ['run', '--', 'node', '--version']);
  assert.equal(timc(repo, ['step', 'complete', 'IMP-001']).code, 0);
  timc(repo, ['phase', 'advance']); // -> VERIFYING

  // hand-written verified_by is ignored
  const spec = path.join(dir, 'spec.md');
  fs.writeFileSync(spec, fs.readFileSync(spec, 'utf8').replace(/text: a failed delivery is retried three times/, '$&\n    verified_by: runtime/evidence/IMP-001-1.json'));
  const blocked = timc(repo, ['phase', 'advance']);
  assert.equal(blocked.code, 2);
  assert.match(blocked.err, /AC-1: not verified/);

  const v = timc(repo, ['verify', 'AC-1']);
  assert.equal(v.code, 0, v.err);
  assert.ok(eventTypes(repo).includes('AC_VERIFIED'));
  assert.equal(timc(repo, ['phase', 'advance']).code, 0);
});

test('H3: a skipped step\'s criterion cannot borrow evidence; only the user can waive it', async (t) => {
  const { repo } = toPlanning(t, 'h3-skip');
  timc(repo, ['step', 'add', '--goal', 'a', '--delivers', 'retry works', '--touches', 'src/**', '--validate', 'node --version', '--acceptance', 'AC-1']);
  timc(repo, ['step', 'add', '--goal', 'b', '--delivers', 'unused', '--touches', 'lib/**', '--validate', 'node --version']);
  timc(repo, ['phase', 'advance']);
  timc(repo, ['approve', 'plan']);
  timc(repo, ['phase', 'advance']);
  timc(repo, ['step', 'skip', 'IMP-001', '--reason', 'moved to a follow-up']);
  timc(repo, ['step', 'start', 'IMP-002']);
  timc(repo, ['run', '--', 'node', '--version']);
  timc(repo, ['step', 'complete', 'IMP-002']);

  const borrowed = timc(repo, ['verify', 'AC-1', '--evidence', 'IMP-002-1']);
  assert.equal(borrowed.code, 2);
  assert.match(borrowed.err, /none is done/);
  assert.equal(timc(repo, ['verify', 'AC-1', '--waive', '--reason', 'descoped'], { agent: true }).code, 2);
  assert.equal(timc(repo, ['verify', 'AC-1', '--waive', '--reason', 'descoped']).code, 0);
});

// --- N3 ---------------------------------------------------------------------

test('N3: only a real trailer satisfies the DONE gate', async (t) => {
  const repo = makeRepo('n3-trailer');
  t.after(() => cleanup(repo));
  const commit = (msg) => git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-q', '-m', msg]);
  commit('feat: x\n\nmentions TIMC-Task: TASK-009 in passing\n\nmore text');
  const { commitsWithTrailer } = await import('../src/git.js');
  assert.deepEqual(commitsWithTrailer(repo, 'TIMC-Task', 'TASK-009'), []);
  commit('feat: y\n\nbody\n\nTIMC-Task: TASK-009');
  assert.equal(commitsWithTrailer(repo, 'TIMC-Task', 'TASK-009').length, 1);
});

// --- N4 ---------------------------------------------------------------------

test('N4: hook context is emitted where Claude Code reads it', async (t) => {
  const repo = makeRepo('n4-hooks');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'fix label typo']);
  const brief = timc(repo, ['brief', '--auto', '--hook']);
  assert.equal(brief.json.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(brief.json.hookSpecificOutput.additionalContext, /TIMC BRIEF/);
  const said = timc(repo, ['prompt', '--hook'], { stdin: promptPayload('hello', { cwd: repo }) });
  assert.match(said.json.hookSpecificOutput.additionalContext, /events#seq=\d+/);
  const hooks = JSON.parse(fs.readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8')).hooks;
  assert.ok(!hooks.PostCompact, 'PostCompact is not a Claude Code event');
  assert.ok(hooks.UserPromptSubmit);
});

// --- N5 ---------------------------------------------------------------------

test('N5: skipping a gate with --force is the user\'s decision', async (t) => {
  const repo = makeRepo('n5-force');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'add bank integration webhook']);
  const denied = timc(repo, ['phase', 'set', 'BUILDING', '--force', '--reason', 'shortcut'], { agent: true });
  assert.equal(denied.code, 2);

  const old = userSays(repo, 'hi');
  userSays(repo, 'skip to building, this is a spike');
  const notLatest = timc(repo, ['phase', 'set', 'BUILDING', '--force', '--reason', 'spike', '--quote', String(old)], { agent: true });
  assert.equal(notLatest.code, 2, 'only the latest message can authorise a force');

  const ok = timc(repo, ['phase', 'set', 'BUILDING', '--force', '--reason', 'spike', '--quote', String(lastSeq(repo))], { agent: true });
  assert.equal(ok.code, 0, ok.err);
  const moved = readEvents(repo).find((e) => e.type === 'PHASE_COMPLETED');
  assert.match(moved.payload.reason, /quote events#seq=/);
});

// --- N6 ---------------------------------------------------------------------

test('N6: a plan with a wrong dependency can be fixed, and skipped steps do not count', async (t) => {
  const { repo } = toPlanning(t, 'n6-plan');
  const add = (...a) => assert.equal(timc(repo, ['step', 'add', ...a]).code, 0);
  add('--kind', 'expand', '--goal', 'add column', '--touches', 'db/**', '--validate', 'node --version', '--acceptance', 'AC-1');
  add('--kind', 'migrate', '--goal', 'move rows', '--touches', 'db/**', '--validate', 'node --version');
  add('--kind', 'contract', '--goal', 'drop column', '--touches', 'db/**', '--validate', 'node --version', '--depends', 'IMP-002');
  const bad = timc(repo, ['phase', 'advance']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /IMP-002 \(migrate\) must be blocked by the expand step/);

  assert.equal(timc(repo, ['step', 'edit', 'IMP-002', '--depends', 'IMP-001']).code, 0);
  assert.equal(timc(repo, ['phase', 'advance']).code, 0);
});

test('N6: remove refuses a step that others depend on', async (t) => {
  const { repo } = toPlanning(t, 'n6-remove');
  timc(repo, ['step', 'add', '--kind', 'prefactor', '--goal', 'a', '--touches', 'src/**', '--validate', 'node --version']);
  timc(repo, ['step', 'add', '--kind', 'prefactor', '--goal', 'b', '--touches', 'src/**', '--validate', 'node --version', '--depends', 'IMP-001']);
  assert.equal(timc(repo, ['step', 'remove', 'IMP-001']).code, 2);
  assert.equal(timc(repo, ['step', 'remove', 'IMP-002']).code, 0);
  assert.equal(timc(repo, ['step', 'remove', 'IMP-001']).code, 0);
});

// --- N7 ---------------------------------------------------------------------

test('N7: a suspended task does not move, and unblock only lifts a block', async (t) => {
  const { repo } = toBuilding(t, 'n7-suspend');
  timc(repo, ['block', 'staging DB is down']);
  const start = timc(repo, ['step', 'start', 'IMP-001']);
  assert.equal(start.code, 2);
  assert.match(start.err, /suspended \(BLOCKED/);
  assert.equal(timc(repo, ['unblock']).code, 0);

  timc(repo, ['abandon', '--reason', 'cancelled']);
  const revive = timc(repo, ['unblock']);
  assert.equal(revive.code, 2);
  assert.match(revive.err, /abandoned task stays abandoned/);
  const ev = readEvents(repo).find((e) => e.type === 'TASK_ABANDONED');
  assert.equal(ev.actor, 'human');
});

// --- N9 / N10 / N11 ---------------------------------------------------------

test('N9: doctor --rebuild reports success once it has fixed the cache', async (t) => {
  const repo = makeRepo('n9-doctor');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'fix label typo']);
  const stateFile = path.join(repo, '.timc', 'runtime', 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.lastEventSeq = 999;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  assert.equal(timc(repo, ['doctor']).code, 2);
  const fixed = timc(repo, ['doctor', '--rebuild']);
  assert.equal(fixed.code, 0, fixed.out + fixed.err);
});

test('N10: the retry limit is reset by the user, and config is not the model\'s to edit', async (t) => {
  const { repo } = toBuilding(t, 'n10-retry');
  for (let k = 0; k < 3; k += 1) {
    timc(repo, ['step', 'start', 'IMP-001']);
    timc(repo, ['step', 'fail', 'IMP-001', '--reason', 'red']);
  }
  const limited = timc(repo, ['step', 'start', 'IMP-001']);
  assert.equal(limited.code, 2);
  assert.match(limited.err, /timc step reset IMP-001/);
  assert.equal(timc(repo, ['step', 'reset', 'IMP-001'], { agent: true }).code, 2);
  assert.equal(timc(repo, ['step', 'reset', 'IMP-001']).code, 0);
  assert.equal(timc(repo, ['step', 'start', 'IMP-001']).code, 0);

  const cfg = path.join(repo, '.timc', 'config', 'workflow.yaml');
  assert.equal(decision(timc(repo, ['guard', 'write', '--hook'], { stdin: writeHookPayload(cfg, { cwd: repo }) })), 'deny');
});

test('N11: the event log and evidence are committed to the .timc repository', async (t) => {
  const repo = makeRepo('n11-journal');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'fix label typo']);
  const tracked = git(path.join(repo, '.timc'), ['ls-files']).split('\n');
  assert.ok(tracked.includes('runtime/events.ndjson'), tracked.join(', '));
  assert.ok(!tracked.includes('runtime/state.json'), 'the cache stays out');
});
