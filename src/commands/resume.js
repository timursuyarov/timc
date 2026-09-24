import path from 'node:path';
import { readJson } from '../io.js';
import { appendEvent, commitState, gitFacts, lastSeq, loadTask, openTasks, readEvents, saveTask } from '../store.js';
import { CLOSED_STEP, actionableStep, next as computeNext, stepsOf } from '../machine.js';
import { verifyStep } from '../evidence.js';
import { c } from '../render.js';
import * as G from '../git.js';

/**
 * Reconcile the three sources of truth before doing anything:
 *   tasks/<id>/task.yaml (committed in .timc)  >  events.ndjson  >  state.json
 * plus git for what the code actually says. When they disagree, TIMC never
 * guesses silently — it reports and, where it is unambiguous, corrects.
 */
export function reconcile(ctx) {
  const findings = [];
  const facts = gitFacts(ctx.codeRoot);
  const state = ctx.state ?? {};
  let task = ctx.task;

  if (!task) {
    const open = openTasks(ctx.P);
    if (open.length === 1) {
      task = open[0];
      findings.push({ level: 'info', text: `active task recovered from disk: ${task.id}` });
    } else if (open.length > 1) {
      findings.push({
        level: 'warn',
        text: `${open.length} open tasks (${open.map((t) => t.id).join(', ')}) — pass --task <ID>`,
      });
    }
  }

  // state.json is a cache. If it claims to be ahead of durable truth, distrust it.
  const seq = lastSeq(ctx.P);
  if ((state.lastEventSeq ?? 0) > seq) {
    findings.push({ level: 'error', text: `state.json references event ${state.lastEventSeq} but the log ends at ${seq} — cache is ahead of the journal` });
  }
  if (task && (state.taskRevision ?? 0) > (task.revision ?? 0)) {
    findings.push({ level: 'error', text: `state.json references task revision ${state.taskRevision} > task.yaml ${task.revision} — rebuild with \`timc doctor --rebuild\`` });
  }
  if (state.git?.head && facts.head && state.git.head !== facts.head) {
    findings.push({ level: 'info', text: `HEAD moved since the last checkpoint (${String(state.git.head).slice(0, 8)} → ${String(facts.head).slice(0, 8)})` });
  }
  if (task?.external?.branch && facts.branch && task.external.branch !== facts.branch && task.track !== 'trivial') {
    findings.push({ level: 'warn', text: `you are on branch ${facts.branch}, the task was started on ${task.external.branch}` });
  }
  // run/record append to runtime/ without the lock, so those are expected to be pending.
  if (G.dirtyPaths(ctx.timcDir).some((p) => !p.startsWith('runtime/'))) {
    findings.push({ level: 'warn', text: '.timc has uncommitted changes — `timc doctor` will commit them' });
  }

  const partial = [];
  if (task) {
    for (const step of stepsOf(task)) {
      const v = verifyStep(ctx.P, task, step);
      if (step.status === 'done' && !v.ok && (step.evidence ?? []).length === 0) {
        partial.push({ step: step.id, kind: 'done_without_evidence', missing: v.missing });
        findings.push({ level: 'error', text: `${step.id} is marked done but has no passing evidence — reopening as needs_fix` });
        step.status = 'needs_fix';
        step.fail_reason = 'reopened by resume: no evidence backs the completed status';
      } else if (step.status === 'in_progress' || step.status === 'validating') {
        const trailer = G.commitsWithTrailer(ctx.codeRoot, 'TIMC-Step', step.id);
        if (!facts.dirty && trailer.length) {
          partial.push({ step: step.id, kind: 'maybe_finished_uncommitted_state' });
          findings.push({ level: 'warn', text: `${step.id} was in progress, the tree is clean and a commit carries its trailer — confirm before closing (not closed automatically)` });
        } else if (facts.dirty) {
          partial.push({ step: step.id, kind: 'interrupted_dirty' });
          findings.push({ level: 'info', text: `${step.id} was interrupted with ${facts.dirtyFiles.length} uncommitted file(s) — continue, then validate` });
        } else {
          partial.push({ step: step.id, kind: 'work_lost' });
          findings.push({ level: 'warn', text: `${step.id} was in progress but the tree is clean and nothing was committed — the work may have been reset` });
        }
      }
    }
  }
  return { task, findings, partial, facts, events: readEvents(ctx.P).length };
}

export async function resume({ args, ctx }) {
  const r = reconcile(ctx);
  ctx.task = r.task;

  const errors = r.findings.filter((f) => f.level === 'error');
  if (r.task) {
    // Clearing a stale suspension is safe; entering RECOVERY_REQUIRED is not automatic.
    if (r.task.suspend && ['PAUSED', 'PAUSED_LIMIT'].includes(r.task.suspend.kind) && !args.flags.keep) {
      appendEvent(ctx.P, { type: 'RESUMED', task: r.task.id, payload: { from: r.task.suspend.kind } });
      r.task.suspend = null;
    }
    if (errors.length && !args.flags['no-recover']) {
      appendEvent(ctx.P, { type: 'RECOVERY_STARTED', task: r.task.id, payload: { findings: errors } });
    }
    ctx.task = saveTask(ctx.P, r.task);
    commitState(ctx, `timc: resume ${ctx.task.id}`);
  }

  const hint = computeNext(ctx);
  const lastCkptId = ctx.state?.lastCheckpoint;
  const ckpt = lastCkptId ? readJson(path.join(ctx.P.checkpointsDir, `${lastCkptId}.json`), null) : null;

  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify({
      task: ctx.task?.id ?? null,
      phase: ctx.task?.phase ?? null,
      findings: r.findings,
      partial: r.partial,
      checkpoint: ckpt ? { id: ckpt.id, at: ckpt.at, stashCommit: ckpt.git?.stashCommit ?? null } : null,
      git: r.facts,
      next: hint,
    }, null, 2)}\n`);
    return 0;
  }

  const L = [];
  L.push(c.bold(r.partial.length ? 'TIMC — uzilgan ish topildi / interrupted work found' : 'TIMC — resume'));
  L.push('');
  if (!ctx.task) {
    L.push('Aktiv task yo\'q / no active task.');
    L.push(`${c.bold('Keyingi / next:')} ${hint.command ?? 'timc status'}`);
    process.stdout.write(`${L.join('\n')}\n`);
    return 0;
  }
  const t = ctx.task;
  const step = actionableStep(t);
  const doneSteps = stepsOf(t).filter((s) => CLOSED_STEP.has(s.status));
  L.push(`${c.bold(t.id)}  ${t.title}`);
  L.push(`Faza / phase:      ${t.phase}${t.suspend ? c.yellow(` (${t.suspend.kind})`) : ''}`);
  L.push(`Oxirgi tugagan:    ${doneSteps.length ? doneSteps[doneSteps.length - 1].id : '—'}`);
  L.push(`Joriy / current:   ${step ? `${step.id} (${step.status})` : '—'}`);
  L.push(`Checkpoint:        ${ckpt ? `${ckpt.id} (${ckpt.at.slice(11, 16)})${ckpt.git?.stashCommit ? ` · stash ${ckpt.git.stashCommit.slice(0, 8)}` : ''}` : '—'}`);
  L.push(`Git:               ${r.facts.branch} @ ${String(r.facts.head ?? '').slice(0, 8)}${r.facts.dirty ? c.yellow(` (dirty: ${r.facts.dirtyFiles.length})`) : c.dim(' (clean)')}`);
  L.push(`Event log:         ${r.events} yozuv / entries`);
  if (r.findings.length) {
    L.push('');
    L.push(c.bold('Reconciliation'));
    for (const f of r.findings) {
      const mark = f.level === 'error' ? c.red('×') : f.level === 'warn' ? c.yellow('!') : c.dim('·');
      L.push(`  ${mark} ${f.text}`);
    }
  }
  L.push('');
  L.push(`${c.bold('Tavsiya / recommended:')} ${hint.title}`);
  if (hint.why) L.push(`  ${c.dim(hint.why)}`);
  if (hint.command) L.push(`  ${c.cyan(hint.command)}`);
  process.stdout.write(`${L.join('\n')}\n`);
  return 0;
}

export default resume;
