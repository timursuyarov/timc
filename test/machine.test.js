import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, retrackAllowed, trackForScore } from '../src/classify.js';
import { commandProves, normalizeCommand } from '../src/evidence.js';
import { globToRegExp, matchesTouches } from '../src/machine.js';

test('classification is deterministic and explains itself', () => {
  const typo = classify('reestr label matn o\'zgartirish — typo');
  assert.equal(typo.track, 'trivial');

  const money = classify('reestrga partial to\'lov qo\'shish + migration');
  assert.equal(money.track, 'high_risk');
  assert.ok(money.signals.includes('money_path'));
  assert.ok(money.signals.includes('schema_change'));

  // same input, same answer
  assert.deepEqual(classify('bank integratsiya webhook'), classify('bank integratsiya webhook'));
  assert.equal(trackForScore(0), 'trivial');
  assert.equal(trackForScore(3), 'standard');
  assert.equal(trackForScore(5), 'high_risk');
});

test('downgrading a track needs a human', () => {
  assert.equal(retrackAllowed('standard', 'high_risk').allowed, true);
  assert.equal(retrackAllowed('high_risk', 'trivial').allowed, false);
  assert.equal(retrackAllowed('high_risk', 'trivial', { byUser: true }).allowed, true);
});

test('normalizeCommand strips only the parts that do not change what ran', () => {
  assert.equal(normalizeCommand('  dotnet   build  '), 'dotnet build');
  assert.equal(normalizeCommand('cd server && dotnet build'), 'dotnet build');
  assert.equal(normalizeCommand('cd "my dir" && cd next && npm test'), 'npm test');
});

test('only a real run of the command counts as proof', () => {
  assert.equal(commandProves('dotnet build', 'dotnet build').ok, true);
  assert.equal(commandProves('dotnet build', 'cd srv && dotnet build').ok, true);
  assert.equal(commandProves('dotnet build', 'dotnet build --no-restore').ok, true);

  // the ways an agent could fake a green build
  assert.equal(commandProves('dotnet build', 'echo "dotnet build"').ok, false);
  assert.equal(commandProves('dotnet build', 'dotnet build || true').ok, false);
  assert.equal(commandProves('dotnet build', 'dotnet build | tail -5').ok, false);
  assert.equal(commandProves('dotnet build', 'dotnet build ; exit 0').ok, false);
  assert.equal(commandProves('dotnet build', 'dotnet builder').ok, false);
  assert.equal(commandProves('dotnet build', 'npm test').ok, false);
});

test('touches globs decide file ownership', () => {
  const step = { touches: ['src/Application/**', 'src/Api/Controllers/Reestr'] };
  assert.equal(matchesTouches(step, 'src/Application/Services/Accrual.cs'), true);
  assert.equal(matchesTouches(step, 'src/Api/Controllers/Reestr/ReestrController.cs'), true);
  assert.equal(matchesTouches(step, 'src/Domain/Entities/Reestr.cs'), false);
  assert.equal(globToRegExp('src/*.js').test('src/a.js'), true);
  assert.equal(globToRegExp('src/*.js').test('src/nested/a.js'), false);
});
