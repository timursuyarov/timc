import fs from 'node:fs';
import path from 'node:path';
import { PROTOCOL_VERSION, TIMC_DIR_NAME, paths } from '../paths.js';
import { ensureDir, writeAtomic, writeJson } from '../io.js';
import { appendEvent, emptyState, gitFacts, saveState } from '../store.js';
import { detectProject } from '../detect.js';
import * as T from '../templates.js';
import * as G from '../git.js';
import { c } from '../render.js';

/** Write a file only if it is absent, so init is safe to re-run. */
function seed(file, contents, created, skipped) {
  if (fs.existsSync(file)) { skipped.push(file); return false; }
  writeAtomic(file, contents);
  created.push(file);
  return true;
}

export async function init({ args, roots }) {
  const codeRoot = roots.codeRoot;
  const timcDir = path.join(codeRoot, TIMC_DIR_NAME);
  const P = paths(timcDir);
  const created = [];
  const skipped = [];

  for (const dir of [P.config, P.knowledge, P.adr, P.tasks, P.templates, P.runtime, P.evidenceDir, P.checkpointsDir, P.briefsDir]) {
    ensureDir(dir);
  }

  const detected = detectProject(codeRoot);
  const name = path.basename(codeRoot);

  seed(P.version, `${PROTOCOL_VERSION}\n`, created, skipped);
  seed(P.agentsMd, T.AGENTS_MD, created, skipped);
  seed(P.gitignore, 'runtime/\n', created, skipped);
  seed(P.project, T.projectYaml(detected, name), created, skipped);
  seed(P.workflow, T.workflowYaml(), created, skipped);
  seed(P.agents, T.agentsYaml(), created, skipped);
  seed(P.permissions, T.permissionsYaml(), created, skipped);
  seed(P.stack, T.stackMd(detected), created, skipped);
  seed(P.dictionary, T.DICTIONARY_MD, created, skipped);
  seed(path.join(P.knowledge, 'architecture.md'), T.ARCHITECTURE_MD, created, skipped);
  seed(path.join(P.knowledge, 'conventions.md'), T.CONVENTIONS_MD, created, skipped);
  seed(path.join(P.knowledge, 'guidelines.md'), T.guidelinesMd(detected.ruleFiles), created, skipped);
  seed(path.join(P.adr, 'INDEX.md'), T.ADR_INDEX_MD, created, skipped);
  seed(P.tasksIndex, '# Tasks\n\n| id | title | track | phase | updated |\n|---|---|---|---|---|\n', created, skipped);

  // Templates the task artifacts are stamped from.
  const stub = { id: 'TASK-000', title: '<title>' };
  seed(path.join(P.templates, 'interview.md'), T.interviewMd(stub), created, skipped);
  seed(path.join(P.templates, 'spec.md'), T.specMd(stub), created, skipped);
  seed(path.join(P.templates, 'plan.md'), T.planMd(stub), created, skipped);
  seed(path.join(P.templates, 'decisions.md'), T.DECISIONS_MD, created, skipped);
  seed(path.join(P.templates, 'risks.md'), T.RISKS_MD, created, skipped);

  // D-2: .timc is its own repository and is excluded from the code repo locally.
  const ownRepo = G.initRepo(timcDir);
  const excluded = G.isRepo(codeRoot) ? G.ensureLocalExclude(codeRoot, `${TIMC_DIR_NAME}/`) : 'no-code-repo';

  if (!fs.existsSync(P.state)) {
    const state = emptyState();
    state.rebuiltAt = null;
    writeJson(P.state, state);
  }

  const ctx = { codeRoot, timcDir, P, state: emptyState(), task: null, config: {} };
  appendEvent(P, {
    type: 'PROJECT_INITIALIZED',
    actor: 'human',
    payload: {
      languages: detected.languages,
      repos: detected.repos,
      commands: detected.commands,
      ownRepoCreated: ownRepo,
      exclude: excluded,
    },
  });
  const facts = gitFacts(codeRoot);
  ctx.state.git = { head: facts.head, branch: facts.branch, dirty: facts.dirty, dirtyDigest: facts.dirtyDigest };
  saveState(P, ctx.state);
  const sha = G.commitAll(timcDir, 'timc: init');

  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify({
      timcDir, created: created.length, skipped: skipped.length, ownRepo, excluded, commit: sha, detected,
    }, null, 2)}\n`);
    return 0;
  }

  const L = [];
  L.push(`${c.bold('TIMC init')} — ${name}`);
  L.push('');
  L.push(`${c.green('✓')} ${TIMC_DIR_NAME}/ ${created.length ? `${created.length} fayl yaratildi / files created` : 'already present'}${skipped.length ? c.dim(` (${skipped.length} kept)`) : ''}`);
  L.push(`${ownRepo ? c.green('✓') : c.dim('–')} ${TIMC_DIR_NAME}/.git ${ownRepo ? 'yaratildi / created (D-2: own repository)' : 'already a repository'}`);
  L.push(`${excluded === 'failed' ? c.yellow('!') : c.green('✓')} code repo .git/info/exclude → ${excluded}`);
  L.push(`${sha ? c.green('✓') : c.dim('–')} first commit ${sha ? sha.slice(0, 8) : '(nothing to commit / git identity missing)'}`);
  L.push('');
  L.push(c.bold('Aniqlangan / detected'));
  L.push(`  languages: ${detected.languages.join(', ') || '—'}`);
  L.push(`  modules:   ${detected.repos.length ? detected.repos.join(', ') : '(single repo)'}`);
  for (const [k, v] of Object.entries(detected.commands)) L.push(`  ${k.padEnd(15)} ${v} ${c.dim('(unverified)')}`);
  if (detected.ruleFiles.length) L.push(`  rules:     ${detected.ruleFiles.slice(0, 5).join(', ')}${detected.ruleFiles.length > 5 ? ' …' : ''}`);
  L.push('');
  L.push(c.dim('Detected commands are marked unverified: run one through `timc run -- <cmd>` before'));
  L.push(c.dim('using it as a step validation, so no step depends on a command that never worked.'));
  L.push('');
  L.push(`${c.bold('Keyingi / next:')} timc new "<what you want to build>"`);
  process.stdout.write(`${L.join('\n')}\n`);
  return 0;
}

export default init;
