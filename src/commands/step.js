import { appendEvent, commitState, saveTask } from '../store.js';
import { verifyStep } from '../evidence.js';
import {
  CLOSED_STEP, STEP_KINDS, actionableStep, depsSatisfied, looksHorizontal, matchesTouches,
  next as computeNext, planAdvisories, stepById, stepsOf,
} from '../machine.js';
import { c } from '../render.js';
import { createCheckpoint } from './checkpoint.js';
import * as G from '../git.js';
import { requireHuman } from '../actor.js';
import { sliceAdvice } from '../jev.js';

const asArray = (v) => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]))
  .flatMap((x) => String(x).split(',').map((s) => s.trim()).filter(Boolean));

const asCommands = (v) => (v === undefined || v === null ? [] : (Array.isArray(v) ? v : [v]))
  .map((x) => String(x).trim()).filter(Boolean);

export async function step({ args, ctx }) {
  const sub = args.positional[0];
  const rest = args.positional.slice(1);
  if (!ctx.task && sub !== 'help') {
    process.stderr.write('timc step: no active task — run `timc new "<title>"` first\n');
    return 1;
  }
  switch (sub) {
    case 'add': return add({ args, ctx });
    case 'list': return list({ args, ctx });
    case 'start': return start({ args, ctx, id: rest[0] });
    case 'complete': return complete({ args, ctx, id: rest[0] });
    case 'fail': return fail({ args, ctx, id: rest[0] });
    case 'skip': return skip({ args, ctx, id: rest[0] });
    case 'edit': return edit({ args, ctx, id: rest[0] });
    case 'remove': return remove({ args, ctx, id: rest[0] });
    case 'reset': return reset({ args, ctx, id: rest[0] });
    default:
      process.stderr.write('timc step: add | list | start <ID> | complete <ID> | fail <ID> | skip <ID> | edit <ID> | remove <ID> | reset <ID>\n');
      return 1;
  }
}

function nextStepId(task, prefix) {
  const used = stepsOf(task)
    .map((s) => /^([A-Z]+)-(\d+)$/.exec(s.id ?? ''))
    .filter((m) => m && m[1] === prefix)
    .map((m) => Number.parseInt(m[2], 10));
  const n = (used.length ? Math.max(...used) : 0) + 1;
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

async function add({ args, ctx }) {
  const goal = String(args.flags.goal ?? args.positional.slice(1).join(' ') ?? '').trim();
  const touches = asArray(args.flags.touches);
  const validate = asCommands(args.flags.validate);
  const delivers = String(args.flags.delivers ?? '').trim();
  const kind = String(args.flags.kind ?? 'slice');
  if (!goal) { process.stderr.write('timc step add: --goal "<what this step achieves>" is required\n'); return 1; }
  if (!touches.length) { process.stderr.write('timc step add: --touches "<glob>[,<glob>]" is required (drift detection needs it)\n'); return 1; }
  if (!validate.length) { process.stderr.write('timc step add: --validate "<command>" is required (nothing could prove the step works)\n'); return 1; }
  if (!STEP_KINDS.includes(kind)) { process.stderr.write(`timc step add: unknown --kind "${kind}" (${STEP_KINDS.join(' | ')})\n`); return 1; }
  if (!delivers && kind === 'slice') {
    process.stderr.write('timc step add: --delivers "<end-to-end behaviour this makes work>" is required for a slice.\n'
      + '  A step is a tracer bullet: a narrow but complete path through every layer, demoable on its own.\n'
      + '  For a layer-shaped chore use --kind prefactor|expand|migrate|contract.\n');
    return 1;
  }

  const id = String(args.flags.id ?? nextStepId(ctx.task, String(args.flags.prefix ?? 'IMP')));
  if (stepById(ctx.task, id)) { process.stderr.write(`timc step add: ${id} already exists\n`); return 1; }
  const entry = {
    id,
    goal,
    delivers: delivers || null,
    kind,
    depends_on: asArray(args.flags.depends),
    owner: String(args.flags.owner ?? 'implementor.backend'),
    touches,
    validate,
    acceptance: args.flags.acceptance ? String(args.flags.acceptance) : null,
    risk: String(args.flags.risk ?? 'low'),
    parallel_group: args.flags.group ? String(args.flags.group) : null,
    status: 'pending',
    started: null,
    finished: null,
    evidence: [],
    commits: [],
  };
  ctx.task.steps = [...stepsOf(ctx.task), entry];
  ctx.task = saveTask(ctx.P, ctx.task);
  appendEvent(ctx.P, { type: 'STEP_ADDED', task: ctx.task.id, step: id, payload: { goal, touches, validate } });
  commitState(ctx, `timc: ${ctx.task.id} ${id} added`);
  if (args.flags.json) { process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`); return 0; }
  const notes = planAdvisories({ steps: [entry] });
  if (kind === 'slice' && !notes.length) {
    const jevNote = await sliceAdvice(ctx, entry);
    if (jevNote) notes.push(jevNote);
  }
  process.stdout.write([
    `${c.green('✓')} ${id} qo'shildi / added ${c.dim(`(${kind})`)} — ${goal}`,
    delivers ? `  delivers: ${delivers}` : '',
    `  validate: ${validate.join(' · ')}`,
    ...notes.map((n) => `  ${c.yellow('!')} ${n}`),
  ].filter(Boolean).join('\n') + '\n');
  return 0;
}

async function list({ args, ctx }) {
  const rows = stepsOf(ctx.task).map((s) => ({
    id: s.id, status: s.status, goal: s.goal, depends_on: s.depends_on ?? [], validate: s.validate ?? [],
    evidence: (s.evidence ?? []).length,
  }));
  if (args.flags.json) { process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`); return 0; }
  if (!rows.length) { process.stdout.write('(no steps)\n'); return 0; }
  for (const r of rows) {
    process.stdout.write(`${r.status.padEnd(12)} ${r.id.padEnd(10)} ${r.goal}\n`);
  }
  return 0;
}

async function start({ args, ctx, id }) {
  const target = id ? stepById(ctx.task, id) : actionableStep(ctx.task);
  if (!target) { process.stderr.write(`timc step start: step ${id ?? '(auto)'} not found\n`); return 1; }
  if (ctx.task.phase !== 'BUILDING') {
    process.stderr.write(`timc step start: task is in ${ctx.task.phase}, not BUILDING — run \`timc phase advance\` first\n`);
    return 2;
  }
  if (suspended(ctx, 'step start')) return 2;
  if (CLOSED_STEP.has(target.status)) { process.stderr.write(`timc step start: ${target.id} is already ${target.status}\n`); return 1; }
  if (!depsSatisfied(ctx.task, target)) {
    const open = (target.depends_on ?? []).filter((d) => !CLOSED_STEP.has(stepById(ctx.task, d)?.status));
    process.stderr.write(`timc step start: ${target.id} depends on ${open.join(', ')}\n`);
    return 2;
  }
  const retries = target.retries ?? 0;
  const limit = Number(ctx.config?.workflow?.limits?.step_retries ?? 3);
  if (retries >= limit) {
    process.stderr.write(`timc step start: ${target.id} has already been retried ${retries} times (limit ${limit}). `
      + `Bring a human in: after they have looked at it, they run \`timc step reset ${target.id}\`.\n`);
    return 2;
  }
  target.status = 'in_progress';
  target.started = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  target.finished = null;
  ctx.state.currentStep = target.id;
  ctx.task = saveTask(ctx.P, ctx.task);
  appendEvent(ctx.P, { type: 'STEP_STARTED', task: ctx.task.id, step: target.id, payload: { retries } });
  commitState(ctx, `timc: ${ctx.task.id} ${target.id} started`);

  const fresh = stepById(ctx.task, target.id);
  if (args.flags.json) { process.stdout.write(`${JSON.stringify(fresh, null, 2)}\n`); return 0; }
  process.stdout.write([
    `${c.cyan('▶')} ${fresh.id} boshlandi / started — ${fresh.goal}`,
    `  touches:  ${(fresh.touches ?? []).join(', ')}`,
    `  validate: ${(fresh.validate ?? []).map((v) => `timc run -- ${v}`).join('\n            ')}`,
    c.dim('  Faqat shu step doirasida ishlang. / Stay inside this step.'),
  ].join('\n') + '\n');
  return 0;
}

async function complete({ args, ctx, id }) {
  const target = id ? stepById(ctx.task, id) : actionableStep(ctx.task);
  if (!target) { process.stderr.write(`timc step complete: step ${id ?? '(auto)'} not found\n`); return 1; }
  if (CLOSED_STEP.has(target.status)) { process.stdout.write(`${target.id} is already ${target.status}\n`); return 0; }
  if (target.status !== 'in_progress' && target.status !== 'validating') {
    process.stderr.write(`timc step complete: ${target.id} is ${target.status} — start it first\n`);
    return 2;
  }
  if (suspended(ctx, 'step complete')) return 2;

  // The gate that makes invariant 13 real: no green status without evidence.
  const v = verifyStep(ctx.P, ctx.task, target);
  if (!v.ok) {
    const L = [c.red(`× ${target.id} yopilmadi / not closed — evidence yetarli emas / insufficient evidence`)];
    for (const m of v.missing) L.push(`  ${c.yellow('·')} ${m.command} — ${m.why}`);
    L.push('');
    L.push(`  ${c.cyan(`timc run -- ${target.validate?.[0] ?? '<validation command>'}`)}`);
    process.stderr.write(`${L.join('\n')}\n`);
    appendEvent(ctx.P, {
      type: 'REPORT_REJECTED',
      task: ctx.task.id,
      step: target.id,
      payload: { missing: v.missing },
    });
    return 2;
  }

  const drift = driftFiles(ctx, target);
  if (drift.length && !args.flags['allow-drift']) {
    appendEvent(ctx.P, { type: 'DRIFT_DETECTED', task: ctx.task.id, step: target.id, payload: { files: drift } });
    const L = [c.yellow(`! ${target.id}: ${drift.length} fayl step touches[] dan tashqarida / file(s) outside this step's touches[]`)];
    for (const f of drift.slice(0, 10)) L.push(`  ${f}`);
    L.push('');
    L.push('  Reja bilan mos qilib touches[] ni yangilang, yoki ongli ravishda davom eting:');
    L.push(`  ${c.cyan(`timc step complete ${target.id} --allow-drift`)}`);
    process.stderr.write(`${L.join('\n')}\n`);
    return 2;
  }

  target.status = 'done';
  target.finished = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  target.evidence = v.satisfied.map((e) => `runtime/evidence/${e.id}.json`);
  if (drift.length) target.drift_accepted = drift;
  ctx.state.lastCompletedStep = target.id;
  ctx.state.currentStep = null;
  ctx.task = saveTask(ctx.P, ctx.task);
  appendEvent(ctx.P, {
    type: 'STEP_COMPLETED',
    task: ctx.task.id,
    step: target.id,
    payload: { evidence: target.evidence, driftAccepted: drift.length },
  });
  const ckpt = createCheckpoint(ctx, { reason: 'STEP_COMPLETED', step: target.id });
  commitState(ctx, `timc: ${ctx.task.id} ${target.id} completed`);

  const hint = computeNext(ctx);
  if (args.flags.json) { process.stdout.write(`${JSON.stringify({ step: target.id, evidence: target.evidence, checkpoint: ckpt?.id ?? null, next: hint }, null, 2)}\n`); return 0; }
  process.stdout.write([
    `${c.green('✓')} ${target.id} yopildi / closed · evidence ${v.satisfied.length}/${(target.validate ?? []).length}`,
    ckpt ? c.dim(`  checkpoint ${ckpt.id}${ckpt.git?.stashCommit ? ` (worktree snapshot ${ckpt.git.stashCommit.slice(0, 8)})` : ''}`) : '',
    '',
    `${c.bold('Keyingi / next:')} ${hint.title}`,
    hint.command ? `  ${c.cyan(hint.command)}` : '',
  ].filter(Boolean).join('\n') + '\n');
  return 0;
}

async function fail({ args, ctx, id }) {
  const target = id ? stepById(ctx.task, id) : actionableStep(ctx.task);
  if (!target) { process.stderr.write('timc step fail: step not found\n'); return 1; }
  const reason = String(args.flags.reason ?? '').trim();
  if (!reason) { process.stderr.write('timc step fail: --reason "<what failed>" is required\n'); return 1; }
  target.status = 'needs_fix';
  target.fail_reason = reason;
  target.retries = (target.retries ?? 0) + 1;
  ctx.task = saveTask(ctx.P, ctx.task);
  appendEvent(ctx.P, { type: 'STEP_FAILED', task: ctx.task.id, step: target.id, payload: { reason, retries: target.retries } });
  commitState(ctx, `timc: ${ctx.task.id} ${target.id} needs fix`);
  process.stdout.write(`${c.red('×')} ${target.id} → needs_fix (retry ${target.retries}) — ${reason}\n`);
  return 0;
}

async function skip({ args, ctx, id }) {
  const target = id ? stepById(ctx.task, id) : null;
  if (!target) { process.stderr.write('timc step skip: give the step id\n'); return 1; }
  const reason = String(args.flags.reason ?? '').trim();
  if (!reason) { process.stderr.write('timc step skip: --reason "<why it is not needed>" is required\n'); return 1; }
  target.status = 'skipped';
  target.skip_reason = reason;
  target.finished = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  ctx.task = saveTask(ctx.P, ctx.task);
  appendEvent(ctx.P, { type: 'STEP_SKIPPED', task: ctx.task.id, step: target.id, payload: { reason } });
  commitState(ctx, `timc: ${ctx.task.id} ${target.id} skipped`);
  process.stdout.write(`${c.dim('–')} ${target.id} skipped — ${reason}\n`);
  return 0;
}

/** A suspended task does not move: say why and what resolves it. */
function suspended(ctx, what) {
  const s = ctx.task.suspend;
  if (!s) return false;
  const how = {
    AWAITING_USER: 'answer the open questions (`timc frontier`)',
    BLOCKED: 'the blocker is resolved with `timc unblock`',
    PAUSED: '`timc resume`',
    PAUSED_LIMIT: '`timc resume`',
    RECOVERY_REQUIRED: '`timc doctor`',
    ABANDONED: 'nothing — the task was abandoned; start a new one',
  }[s.kind] ?? '`timc resume`';
  process.stderr.write(`timc ${what}: ${ctx.task.id} is suspended (${s.kind}${s.reason ? `: ${s.reason}` : ''}) — ${how}\n`);
  return true;
}

const EDITABLE = new Set(['pending', 'ready']);

/** `timc step edit <ID> [--goal] [--delivers] [--touches] [--validate] [--depends] [--acceptance] [--kind]` */
async function edit({ args, ctx, id }) {
  const target = id ? stepById(ctx.task, id) : null;
  if (!target) { process.stderr.write(`timc step edit: step ${id ?? '<ID>'} not found\n`); return 1; }
  if (!EDITABLE.has(target.status)) {
    process.stderr.write(`timc step edit: ${target.id} is ${target.status} — only a step that has not started can be edited\n`);
    return 2;
  }
  const changes = {};
  if (args.flags.goal !== undefined) changes.goal = String(args.flags.goal).trim();
  if (args.flags.delivers !== undefined) changes.delivers = String(args.flags.delivers).trim() || null;
  if (args.flags.touches !== undefined) changes.touches = asArray(args.flags.touches);
  if (args.flags.validate !== undefined) changes.validate = asCommands(args.flags.validate);
  if (args.flags.depends !== undefined) changes.depends_on = args.flags.depends === true ? [] : asArray(args.flags.depends);
  if (args.flags.acceptance !== undefined) changes.acceptance = args.flags.acceptance === true ? null : String(args.flags.acceptance);
  if (args.flags.kind !== undefined) {
    if (!STEP_KINDS.includes(String(args.flags.kind))) { process.stderr.write(`timc step edit: unknown --kind (${STEP_KINDS.join(' | ')})\n`); return 1; }
    changes.kind = String(args.flags.kind);
  }
  if (!Object.keys(changes).length) { process.stderr.write('timc step edit: nothing to change\n'); return 1; }
  for (const d of changes.depends_on ?? []) {
    if (d === target.id || !stepById(ctx.task, d)) { process.stderr.write(`timc step edit: unknown or self dependency ${d}\n`); return 1; }
  }
  const next = { ...target, ...changes };
  if (!next.touches?.length || !next.validate?.length) { process.stderr.write('timc step edit: touches and validate cannot be empty\n'); return 1; }
  if (next.kind === 'slice' && !next.delivers) { process.stderr.write('timc step edit: a slice needs --delivers\n'); return 1; }
  Object.assign(target, changes);
  ctx.task = saveTask(ctx.P, ctx.task);
  appendEvent(ctx.P, { type: 'STEP_EDITED', task: ctx.task.id, step: target.id, payload: { changes } });
  commitState(ctx, `timc: ${ctx.task.id} ${target.id} edited`);
  process.stdout.write(`${c.green('✓')} ${target.id} o'zgartirildi / edited — ${Object.keys(changes).join(', ')}\n`
    + (ctx.task.approvals?.plan ? c.dim('  plan tasdig\'i endi eskirdi / plan approval is now stale\n') : ''));
  return 0;
}

/** `timc step remove <ID>` — only a step that never started and nothing depends on. */
async function remove({ ctx, id }) {
  const target = id ? stepById(ctx.task, id) : null;
  if (!target) { process.stderr.write(`timc step remove: step ${id ?? '<ID>'} not found\n`); return 1; }
  if (!EDITABLE.has(target.status) || (target.evidence ?? []).length) {
    process.stderr.write(`timc step remove: ${target.id} is ${target.status} — work that started stays in the record; use \`timc step skip\`\n`);
    return 2;
  }
  const dependents = stepsOf(ctx.task).filter((s) => (s.depends_on ?? []).includes(target.id));
  if (dependents.length) {
    process.stderr.write(`timc step remove: ${dependents.map((s) => s.id).join(', ')} depend on ${target.id} — edit their --depends first\n`);
    return 2;
  }
  ctx.task.steps = stepsOf(ctx.task).filter((s) => s.id !== target.id);
  ctx.task = saveTask(ctx.P, ctx.task);
  appendEvent(ctx.P, { type: 'STEP_REMOVED', task: ctx.task.id, step: target.id, payload: { goal: target.goal } });
  commitState(ctx, `timc: ${ctx.task.id} ${target.id} removed`);
  process.stdout.write(`${c.dim('–')} ${target.id} olib tashlandi / removed — ${target.goal}\n`);
  return 0;
}

/** `timc step reset <ID>` — the user clears the retry counter after looking at the failures. */
async function reset({ args, ctx, id }) {
  const target = id ? stepById(ctx.task, id) : null;
  if (!target) { process.stderr.write(`timc step reset: step ${id ?? '<ID>'} not found\n`); return 1; }
  const who = await requireHuman(ctx, args, {
    action: `Resetting ${target.id}'s retry limit`,
    latest: true,
    claim: `Let the agent retry step ${target.id} (${target.goal}) again after ${target.retries ?? 0} failed attempts`,
  });
  if (who.ok === false) { process.stderr.write(`timc step reset: ${who.why}\n`); return 2; }
  const was = target.retries ?? 0;
  target.retries = 0;
  ctx.task = saveTask(ctx.P, ctx.task);
  appendEvent(ctx.P, { type: 'STEP_RESET', task: ctx.task.id, step: target.id, actor: 'human', payload: { retries: was, quote: who.quote } });
  commitState(ctx, `timc: ${ctx.task.id} ${target.id} retries reset`);
  process.stdout.write(`${c.green('✓')} ${target.id} retries ${was} → 0\n  ${c.cyan(`timc step start ${target.id}`)}\n`);
  return 0;
}

/** Dirty files in the code repo that no step in the plan claims. */
export function driftFiles(ctx, step) {
  const facts = G.worktree(ctx.codeRoot);
  return facts.files.filter((f) => {
    if (f.startsWith('.timc/')) return false;
    return !matchesTouches(step, f);
  });
}

export default step;
