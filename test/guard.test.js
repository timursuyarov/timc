import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { bashHookPayload, cleanup, makeRepo, timc, writeHookPayload } from './helpers.js';

const decision = (res) => res.json?.hookSpecificOutput?.permissionDecision ?? null;

test('the model cannot write its own evidence or state', async (t) => {
  const repo = makeRepo('guard-runtime');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);

  const evidenceFile = path.join(repo, '.timc', 'runtime', 'evidence', 'IMP-001-1.json');
  const denied = timc(repo, ['guard', 'write', '--hook'], { stdin: writeHookPayload(evidenceFile, { cwd: repo }) });
  assert.equal(decision(denied), 'deny');
  assert.match(denied.json.hookSpecificOutput.permissionDecisionReason, /harness/i);

  const src = timc(repo, ['guard', 'write', '--hook'], { stdin: writeHookPayload(path.join(repo, 'src', 'index.js'), { cwd: repo }) });
  assert.equal(decision(src), null, 'ordinary source files are not blocked');
});

test('task.yaml is owned by the CLI', async (t) => {
  const repo = makeRepo('guard-task');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'fix label typo', '--json']);
  const taskYaml = path.join(repo, '.timc', 'tasks', 'TASK-001-fix-label-typo', 'task.yaml');
  const res = timc(repo, ['guard', 'write', '--hook'], { stdin: writeHookPayload(taskYaml, { cwd: repo }) });
  assert.equal(decision(res), 'deny');
});

test('the orchestrator does not write production code on a standard track', async (t) => {
  const repo = makeRepo('guard-orchestrator');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'add bank integration webhook', '--json']);
  timc(repo, ['phase', 'set', 'BUILDING', '--force', '--reason', 'test fixture']);
  const target = path.join(repo, 'src', 'index.js');

  // main session: no agent_id -> denied
  const main = timc(repo, ['guard', 'write', '--hook'], { stdin: writeHookPayload(target, { cwd: repo }) });
  assert.equal(decision(main), 'deny');
  assert.match(main.json.hookSpecificOutput.permissionDecisionReason, /implementor subagent/i);

  // subagent: agent_id present -> allowed
  const sub = timc(repo, ['guard', 'write', '--hook'], { stdin: writeHookPayload(target, { cwd: repo, agentId: 'agent-123' }) });
  assert.equal(decision(sub), null);
});

test('a trivial task may be implemented by the orchestrator', async (t) => {
  const repo = makeRepo('guard-trivial');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'fix label typo', '--json']);
  timc(repo, ['phase', 'advance']);
  const res = timc(repo, ['guard', 'write', '--hook'], { stdin: writeHookPayload(path.join(repo, 'src', 'index.js'), { cwd: repo }) });
  assert.equal(decision(res), null);
});

test('editing outside the step reports drift without blocking', async (t) => {
  const repo = makeRepo('guard-drift');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'fix label typo', '--json']);
  timc(repo, ['phase', 'advance']);
  timc(repo, ['step', 'add', '--goal', 'a', '--touches', 'src/**', '--validate', 'node --version']);
  timc(repo, ['step', 'start', 'IMP-001']);

  const res = timc(repo, ['guard', 'write', '--hook'], { stdin: writeHookPayload(path.join(repo, 'package.json'), { cwd: repo }) });
  assert.equal(decision(res), null, 'drift informs, it does not block');
  assert.match(res.json.additionalContext, /scope drift/i);
});

test('destructive commands are denied', async (t) => {
  const repo = makeRepo('guard-bash');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  const res = timc(repo, ['guard', 'bash', '--hook'], { stdin: bashHookPayload('dotnet ef database drop --force', { cwd: repo }) });
  assert.equal(decision(res), 'deny');

  const ok = timc(repo, ['guard', 'bash', '--hook'], { stdin: bashHookPayload('dotnet build', { cwd: repo }) });
  assert.equal(decision(ok), null);
});

test('hooks stay silent in a project without .timc', async (t) => {
  const repo = makeRepo('guard-uninit');
  t.after(() => cleanup(repo));
  const res = timc(repo, ['guard', 'write', '--hook'], { stdin: writeHookPayload(path.join(repo, 'src', 'index.js'), { cwd: repo }) });
  assert.equal(res.code, 0);
  assert.equal(res.out.trim(), '');
});
