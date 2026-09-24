import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  bashGuardPayload, cleanup, makeRepo, promptPayload, readEvents, ROOT, timc,
} from './helpers.js';

/**
 * Jev is optional and may only make TIMC stricter. These tests run against a
 * fake /v1/systemone server in its own process — never the real API.
 */

async function fakeJev(t) {
  const log = path.join(ROOT, 'test', '.tmp', `jev-${process.pid}-${Date.now()}.ndjson`);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'test', 'fixtures', 'fake-jev.js'), log], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { child.kill(); fs.rmSync(log, { force: true }); });
  const port = await new Promise((resolve, reject) => {
    child.stdout.once('data', (d) => resolve(Number(String(d).trim())));
    child.once('error', reject);
  });
  return { base: `http://127.0.0.1:${port}`, requests: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []) };
}

/** The user (not the model) turns Jev on in the guarded config. */
function enableJev(repo, jev) {
  const file = path.join(repo, '.timc', 'config', 'workflow.yaml');
  const cfg = YAML.parse(fs.readFileSync(file, 'utf8'));
  cfg.jev = { ...cfg.jev, enabled: true, ...jev };
  fs.writeFileSync(file, YAML.stringify(cfg));
}

const KEY = { OPENROUTER_API_KEY: 'test-key' };
const userSays = (repo, text) => {
  timc(repo, ['prompt', '--hook'], { stdin: promptPayload(text, { cwd: repo }) });
  return readEvents(repo).filter((e) => e.type === 'USER_PROMPT').at(-1).seq;
};

function questionRepo(t, name) {
  const repo = makeRepo(name);
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  timc(repo, ['new', 'add bank integration webhook']);
  timc(repo, ['phase', 'advance']);
  timc(repo, ['ask', 'Retry a failed delivery?', '--recommend', 'yes, 3 times']);
  return repo;
}

test('jev: a hesitant message cannot be quoted as an answer', async (t) => {
  const jev = await fakeJev(t);
  const repo = questionRepo(t, 'jev-quote');
  enableJev(repo, { base_url: jev.base });

  const unsure = userSays(repo, 'hmm, not sure yet — let me check with the bank');
  const refused = timc(repo, ['answer', 'Q-001', 'yes, 3 times', '--quote', String(unsure)], { agent: true, env: KEY });
  assert.equal(refused.code, 2);
  assert.match(refused.err, /does not read as the user authorising this/);

  const clear = userSays(repo, 'yes, retry three times with backoff');
  const ok = timc(repo, ['answer', 'Q-001', 'yes, 3 times with backoff', '--quote', String(clear)], { agent: true, env: KEY });
  assert.equal(ok.code, 0, ok.err);
  const answer = readEvents(repo).find((e) => e.type === 'ANSWER_RECEIVED');
  assert.equal(answer.payload.quote.jev.verdict, 'ok');

  const [first] = jev.requests();
  assert.equal(first.url, '/v1/systemone');
  assert.equal(first.auth, 'Bearer test-key');
  assert.equal(first.body.model, 'typesafe/jev-latest');
  assert.ok(first.body.questions.supports && first.body.questions.kind);
  assert.equal(readEvents(repo).filter((e) => e.type === 'JEV_DECISION').length, 2, 'every call is audited');
});

test('jev: the native TypeSafe transport uses its own key and model id', async (t) => {
  const jev = await fakeJev(t);
  const repo = questionRepo(t, 'jev-native');
  enableJev(repo, { base_url: jev.base, provider: 'typesafe' });
  const said = userSays(repo, 'yes, three times');
  const noKey = timc(repo, ['answer', 'Q-001', 'yes', '--quote', String(said)], { agent: true, env: KEY });
  assert.equal(noKey.code, 0, 'without TYPESAFE_API_KEY the check is skipped (fail-open)…');
  assert.match(noKey.err, /TYPESAFE_API_KEY is not set/, '…and says so');
  assert.equal(jev.requests().length, 0);

  const repo2 = questionRepo(t, 'jev-native-2');
  enableJev(repo2, { base_url: jev.base, provider: 'typesafe' });
  const said2 = userSays(repo2, 'yes, three times');
  timc(repo2, ['answer', 'Q-001', 'yes', '--quote', String(said2)], { agent: true, env: { TYPESAFE_API_KEY: 'native-key' } });
  const [req] = jev.requests();
  assert.equal(req.auth, 'Bearer native-key');
  assert.equal(req.body.model, 'jev-latest');
});

test('jev: unreachable fails open, unless the user made it required', async (t) => {
  const repo = questionRepo(t, 'jev-down');
  enableJev(repo, { base_url: 'http://127.0.0.1:9', timeout_ms: 1500 });
  const said = userSays(repo, 'yes, three times');
  const open = timc(repo, ['answer', 'Q-001', 'yes', '--quote', String(said)], { agent: true, env: KEY });
  assert.equal(open.code, 0, open.err);
  assert.match(open.err, /quote not checked: jev unreachable/);

  const repo2 = questionRepo(t, 'jev-down-required');
  enableJev(repo2, { base_url: 'http://127.0.0.1:9', timeout_ms: 1500, required: true });
  const said2 = userSays(repo2, 'yes, three times');
  const closed = timc(repo2, ['answer', 'Q-001', 'yes', '--quote', String(said2)], { agent: true, env: KEY });
  assert.equal(closed.code, 2);
  // the user in their own terminal never depends on Jev
  assert.equal(timc(repo2, ['answer', 'Q-001', 'yes']).code, 0);
});

test('jev: may raise a track, never lower it', async (t) => {
  const jev = await fakeJev(t);
  const repo = makeRepo('jev-track');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  enableJev(repo, { base_url: jev.base });

  const up = timc(repo, ['new', 'add ledger export', '--json'], { env: KEY });
  assert.equal(up.code, 0, up.err);
  assert.equal(up.json.track, 'high_risk', 'keywords say trivial, Jev is confident it is high_risk');
  assert.ok(up.json.classification.signals.includes('jev:high_risk'));
  assert.equal(up.json.classification.keyword_track, 'trivial');

  const kept = timc(repo, ['new', 'add partial refunds', '--json'], { env: KEY });
  assert.equal(kept.json.track, 'standard', 'Jev saying "trivial" does not lower a money-path task');
});

test('jev: advisories on horizontal slices and weak evidence', async (t) => {
  const jev = await fakeJev(t);
  const repo = makeRepo('jev-advice');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  enableJev(repo, { base_url: jev.base });
  timc(repo, ['new', 'fix label typo'], { env: KEY });
  timc(repo, ['phase', 'advance'], { env: KEY });
  const add = timc(repo, ['step', 'add', '--goal', 'wire the label', '--delivers', 'repository layer for labels',
    '--touches', 'src/**', '--validate', 'node --version'], { env: KEY });
  assert.equal(add.code, 0, add.err);
  assert.match(add.out, /reads like a horizontal layer/);
});

test('jev: its config and credentials are out of the model\'s reach', async (t) => {
  const repo = makeRepo('jev-guard');
  t.after(() => cleanup(repo));
  timc(repo, ['init']);
  const guard = (cmd) => timc(repo, ['guard', 'bash', '--hook'], { stdin: bashGuardPayload(cmd, { cwd: repo }) }).json?.hookSpecificOutput?.permissionDecision ?? null;
  assert.equal(guard('echo $OPENROUTER_API_KEY'), 'deny');
  assert.equal(guard('env -u TYPESAFE_API_KEY timc answer Q-001 yes'), 'deny');
  assert.equal(guard("sed -i 's/enabled: true/enabled: false/' .timc/config/workflow.yaml"), 'deny');
});
