import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanup, makeRepo, timc } from './helpers.js';
import { expandContractProblems, looksHorizontal, planAdvisories } from '../src/machine.js';

/** Tracer-bullet slices, blocking edges, and the expand→migrate→contract exception. */

test('layer-shaped steps are recognised as horizontal', () => {
  assert.equal(looksHorizontal({ goal: 'Domain model for refunds' }), true);
  assert.equal(looksHorizontal({ goal: 'Repository layer' }), true);
  assert.equal(looksHorizontal({ goal: 'API controller' }), true);
  assert.equal(looksHorizontal({ goal: 'Refund a paid order end to end' }), false);
  // a declared end-to-end outcome rehabilitates the title
  assert.equal(looksHorizontal({ goal: 'API endpoint', delivers: 'a client can request a partial refund' }), false);
});

test('advisories flag build-only validation', () => {
  const notes = planAdvisories({
    steps: [{ id: 'IMP-001', goal: 'Refund flow', delivers: 'x', validate: ['dotnet build'], kind: 'slice' }],
  });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /only compiles/);

  const ok = planAdvisories({
    steps: [{ id: 'IMP-002', goal: 'Refund flow', delivers: 'x', validate: ['dotnet test --filter Refund'], kind: 'slice' }],
  });
  assert.deepEqual(ok, []);
});

test('expand -> migrate* -> contract ordering is enforced', () => {
  const bad = {
    steps: [
      { id: 'R-001', kind: 'expand', depends_on: [] },
      { id: 'R-002', kind: 'migrate', depends_on: [] },
      { id: 'R-003', kind: 'contract', depends_on: ['R-001'] },
    ],
  };
  const problems = expandContractProblems(bad);
  assert.ok(problems.some((p) => /R-002 \(migrate\) must be blocked by the expand/.test(p)));
  assert.ok(problems.some((p) => /R-003 \(contract\) must be blocked by every migrate/.test(p)));

  const good = {
    steps: [
      { id: 'R-001', kind: 'expand', depends_on: [] },
      { id: 'R-002', kind: 'migrate', depends_on: ['R-001'] },
      { id: 'R-003', kind: 'migrate', depends_on: ['R-001'] },
      { id: 'R-004', kind: 'contract', depends_on: ['R-002', 'R-003'] },
    ],
  };
  assert.deepEqual(expandContractProblems(good), []);

  // transitive blocking counts
  const chained = {
    steps: [
      { id: 'R-001', kind: 'expand', depends_on: [] },
      { id: 'R-002', kind: 'migrate', depends_on: ['R-001'] },
      { id: 'R-003', kind: 'contract', depends_on: ['R-002'] },
    ],
  };
  assert.deepEqual(expandContractProblems(chained), []);

  const orphan = { steps: [{ id: 'R-001', kind: 'migrate', depends_on: [] }] };
  assert.ok(expandContractProblems(orphan).some((p) => /without an expand step/.test(p)));
});

test('a slice must say what it delivers', async (t) => {
  const repo = makeRepo('slice-delivers');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'fix label typo', '--json']);
  timc(repo, ['phase', 'advance']);

  const bad = timc(repo, ['step', 'add', '--goal', 'Domain model', '--touches', 'src/**', '--validate', 'node --version']);
  assert.notEqual(bad.code, 0);
  assert.match(bad.err, /--delivers/);

  // a layer-shaped chore is allowed when it is named as one
  const chore = timc(repo, ['step', 'add', '--goal', 'Rename column', '--kind', 'expand', '--touches', 'src/**', '--validate', 'node --version', '--json']);
  assert.equal(chore.code, 0, chore.err);
  assert.equal(chore.json.kind, 'expand');

  const slice = timc(repo, ['step', 'add', '--goal', 'Partial refund', '--delivers', 'a client can request a partial refund and see it applied', '--touches', 'src/**', '--validate', 'node --version', '--json']);
  assert.equal(slice.code, 0, slice.err);
  assert.equal(slice.json.delivers, 'a client can request a partial refund and see it applied');
});

test('the step frontier follows blocking edges', async (t) => {
  const repo = makeRepo('slice-frontier');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'fix label typo', '--json']);
  timc(repo, ['phase', 'advance']);
  timc(repo, ['step', 'add', '--goal', 'A', '--delivers', 'a works', '--touches', 'src/**', '--validate', 'node --version']);
  timc(repo, ['step', 'add', '--goal', 'B', '--delivers', 'b works', '--touches', 'src/**', '--validate', 'node --version', '--depends', 'IMP-001']);

  const front = timc(repo, ['frontier', '--json']).json;
  assert.deepEqual(front.steps.frontier.map((s) => s.id), ['IMP-001']);
  assert.deepEqual(front.steps.blocked[0], { id: 'IMP-002', waiting_on: ['IMP-001'] });
});
