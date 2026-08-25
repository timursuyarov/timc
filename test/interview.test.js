import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, makeRepo, timc } from './helpers.js';
import { blockedQuestions, frontier } from '../src/machine.js';

/**
 * The interview as a design tree worked in rounds (grilling), and the plan as
 * tracer-bullet tickets with blocking edges (to-tickets). Both are encoded as
 * data so the gates can decide, instead of the model deciding it asked enough.
 */

function framing(t, name) {
  const repo = makeRepo(name);
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'add bank integration webhook', '--json']);
  timc(repo, ['phase', 'advance']); // CREATED -> FRAMING
  return repo;
}

test('frontier and blocked questions come from declared prerequisites', () => {
  const task = {
    open_questions: [
      { id: 'Q-001', answer: 'yes' },
      { id: 'Q-002', depends_on: ['Q-001'], answer: null },
      { id: 'Q-003', depends_on: ['Q-002'], answer: null },
      { id: 'Q-004', depends_on: [], answer: null },
    ],
  };
  assert.deepEqual(frontier(task).map((q) => q.id), ['Q-002', 'Q-004']);
  assert.deepEqual(blockedQuestions(task).map((q) => q.id), ['Q-003']);
});

test('a question needs a recommended answer', async (t) => {
  const repo = framing(t, 'iv-recommend');
  const bad = timc(repo, ['ask', 'Can one payment have several refunds?']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /--recommend/);

  const ok = timc(repo, ['ask', 'Can one payment have several refunds?', '--recommend', 'yes, capped at the paid amount', '--json']);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(ok.json.round, 1);
});

test('a round asks the frontier at once and stays open until it is empty', async (t) => {
  const repo = framing(t, 'iv-rounds');
  timc(repo, ['ask', 'Several refunds per payment?', '--recommend', 'yes', '--json']);
  timc(repo, ['ask', 'Retroactive recalculation?', '--recommend', 'no', '--json']);
  const front = timc(repo, ['frontier', '--json']).json;
  assert.equal(front.questions.frontier.length, 2);
  assert.equal(front.questions.frontier[0].round, 1);

  // one answer does not end the round
  timc(repo, ['answer', 'Q-001', 'yes, capped at the paid amount']);
  let status = timc(repo, ['status', '--json']).json;
  assert.equal(status.task.suspend.kind, 'AWAITING_USER', 'still waiting on Q-002');
  assert.equal(timc(repo, ['next', '--json']).json.action, 'answer_questions');

  timc(repo, ['answer', 'Q-002', 'no']);
  status = timc(repo, ['status', '--json']).json;
  assert.equal(status.task.suspend, null, 'an empty frontier ends the wait');
});

test('a question that depends on an open question is not askable yet', async (t) => {
  const repo = framing(t, 'iv-depends');
  timc(repo, ['ask', 'Do we support partial refunds?', '--recommend', 'yes', '--json']);
  timc(repo, ['ask', 'How is a partial refund split?', '--recommend', 'pro rata', '--depends', 'Q-001', '--json']);
  const front = timc(repo, ['frontier', '--json']).json;
  assert.deepEqual(front.questions.frontier.map((q) => q.id), ['Q-001']);
  assert.deepEqual(front.questions.blocked.map((q) => q.id), ['Q-002']);

  const unknownDep = timc(repo, ['ask', 'x', '--recommend', 'y', '--depends', 'Q-099']);
  assert.notEqual(unknownDep.code, 0);
});

test('the interview gate closes only when every question is answered', async (t) => {
  const repo = framing(t, 'iv-gate');
  const taskDir = path.join(repo, '.timc', 'tasks', 'TASK-001-add-bank-integration-webhook');
  const interview = path.join(taskDir, 'interview.md');
  fs.writeFileSync(interview, fs.readFileSync(interview, 'utf8')
    .replace('## Confirmed facts\n', '## Confirmed facts\n\n- the webhook fires once per payment\n'));

  // no questions at all: an interview that asked nothing decided nothing
  const none = timc(repo, ['phase', 'advance']);
  assert.equal(none.code, 2);
  assert.match(none.err, /asked nothing/i);

  timc(repo, ['ask', 'Several refunds per payment?', '--recommend', 'yes', '--json']);
  const open = timc(repo, ['phase', 'advance']);
  assert.equal(open.code, 2);
  assert.match(open.err, /unanswered/i);

  timc(repo, ['answer', 'Q-001', 'yes, capped']);
  const done = timc(repo, ['phase', 'advance', '--json']);
  assert.equal(done.code, 0, done.err);
  assert.equal(done.json.to, 'SPECIFYING');
});

test('the answer is recorded verbatim and linked to an event', async (t) => {
  const repo = framing(t, 'iv-evidence');
  timc(repo, ['ask', 'Cap refunds at the paid amount?', '--recommend', 'yes', '--json']);
  timc(repo, ['answer', 'Q-001', 'yes — never above the captured amount']);
  const taskYaml = fs.readFileSync(
    path.join(repo, '.timc', 'tasks', 'TASK-001-add-bank-integration-webhook', 'task.yaml'), 'utf8',
  );
  assert.match(taskYaml, /never above the captured amount/);
  assert.match(taskYaml, /evidence: events#seq=\d+/, 'a user decision must point at the event that carries it');
});
