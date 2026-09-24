import fs from 'node:fs';
import { emptyState, appendEvent, commitState, listTasks, openTasks, readEvents, saveState } from '../store.js';
import { PHASES, stepsOf, STEP_STATUSES } from '../machine.js';
import { reconcile } from './resume.js';
import { c } from '../render.js';
import * as G from '../git.js';
import { readText, writeAtomic } from '../io.js';
import { TIMC_GITIGNORE } from '../templates.js';

/**
 * `timc doctor [--rebuild]`
 * Verifies the structure, and can rebuild runtime/state.json from durable truth
 * (task.yaml in the .timc repo + the event log + git). This is what makes a
 * fresh clone — or a wiped runtime/ — resumable.
 */
export async function doctor({ args, ctx }) {
  const problems = [];
  const fixed = [];

  for (const [label, p] of [
    ['config/project.yaml', ctx.P.project],
    ['config/workflow.yaml', ctx.P.workflow],
    ['knowledge/dictionary.md', ctx.P.dictionary],
    ['VERSION', ctx.P.version],
    ['AGENTS.md', ctx.P.agentsMd],
  ]) {
    if (!fs.existsSync(p)) problems.push(`missing ${label} — re-run \`timc init\``);
  }
  if (!G.isRepo(ctx.timcDir)) problems.push('.timc is not its own git repository (decision D-2) — re-run `timc init`');

  const tasks = listTasks(ctx.P);
  for (const t of tasks) {
    if (!PHASES.includes(t.phase)) problems.push(`${t.id}: unknown phase "${t.phase}"`);
    const ids = new Set();
    for (const s of stepsOf(t)) {
      if (!STEP_STATUSES.includes(s.status)) problems.push(`${t.id}/${s.id}: unknown status "${s.status}"`);
      if (ids.has(s.id)) problems.push(`${t.id}: duplicate step id ${s.id}`);
      ids.add(s.id);
      for (const dep of s.depends_on ?? []) {
        if (!stepsOf(t).some((x) => x.id === dep)) problems.push(`${t.id}/${s.id}: depends on unknown step ${dep}`);
      }
    }
  }

  // V0 ignored all of runtime/, so the journal never reached git.
  if (readText(ctx.P.gitignore, '').trim() === 'runtime/') {
    writeAtomic(ctx.P.gitignore, TIMC_GITIGNORE);
    fixed.push('.timc/.gitignore: events and evidence are now committed (was: runtime/ ignored)');
  }

  if (args.flags.rebuild) {
    const state = emptyState();
    const open = openTasks(ctx.P);
    const active = ctx.task ?? (open.length === 1 ? open[0] : null);
    const events = readEvents(ctx.P);
    state.activeTask = active?.id ?? null;
    state.phase = active?.phase ?? null;
    state.taskRevision = active?.revision ?? 0;
    state.suspend = active?.suspend ?? null;
    state.lastEventSeq = events.length ? events[events.length - 1].seq : 0;
    state.currentStep = active ? stepsOf(active).find((s) => s.status === 'in_progress' || s.status === 'validating')?.id ?? null : null;
    state.lastCompletedStep = active
      ? [...stepsOf(active)].reverse().find((s) => s.status === 'done')?.id ?? null
      : null;
    const checkpoints = fs.existsSync(ctx.P.checkpointsDir)
      ? fs.readdirSync(ctx.P.checkpointsDir).filter((f) => f.endsWith('.json')).sort()
      : [];
    state.lastCheckpoint = checkpoints.length ? checkpoints[checkpoints.length - 1].replace(/\.json$/, '') : null;
    state.rebuiltAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    saveState(ctx.P, state);
    ctx.state = state;
    ctx.task = active;
    fixed.push('runtime/state.json rebuilt from task.yaml + event log + git');
    appendEvent(ctx.P, { type: 'RECOVERY_RESOLVED', task: state.activeTask, payload: { rebuilt: true } });
  }

  // Reconcile after any rebuild, so a problem the rebuild just fixed is not reported.
  const r = reconcile(ctx);
  for (const f of r.findings.filter((x) => x.level !== 'info')) problems.push(f.text);

  // .timc must never be left dirty: uncommitted process state is lost state.
  if (!G.isClean(ctx.timcDir)) {
    const sha = G.commitAll(ctx.timcDir, 'timc: recovered state');
    if (sha) fixed.push(`.timc committed (${sha.slice(0, 8)})`);
  }
  if (ctx.state) commitState(ctx, 'timc: doctor');

  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify({ problems, fixed, tasks: tasks.length }, null, 2)}\n`);
    return problems.length ? 2 : 0;
  }
  const L = [c.bold('TIMC doctor')];
  L.push('');
  L.push(`tasks: ${tasks.length} · open: ${openTasks(ctx.P).length} · events: ${readEvents(ctx.P).length}`);
  for (const f of fixed) L.push(`  ${c.green('✓')} ${f}`);
  if (!problems.length) L.push(`  ${c.green('✓')} muammo topilmadi / no problems found`);
  else for (const p of problems) L.push(`  ${c.yellow('!')} ${p}`);
  if (problems.length && !args.flags.rebuild) {
    L.push('');
    L.push(`  ${c.cyan('timc doctor --rebuild')} ${c.dim('— rebuild runtime state from durable truth')}`);
  }
  process.stdout.write(`${L.join('\n')}\n`);
  return problems.length ? 2 : 0;
}

export default doctor;
