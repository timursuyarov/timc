import path from 'node:path';
import { appendEvent, commitState, readEvents, saveTask } from '../store.js';
import { nowIso, writeAtomic } from '../io.js';
import { questionById } from '../machine.js';
import { c } from '../render.js';

export const DECISION_TYPES = ['BUSINESS', 'ARCHITECTURE', 'IMPLEMENTATION', 'TEMPORARY_ASSUMPTION'];

/**
 * A decision the user made must be backed by the answer that carries it.
 * Without this check, "the user approved it" is just something a model can type.
 * @returns {{ok: true, ref: string} | {ok: false, why: string}}
 */
export function resolveUserEvidence(ctx, ref) {
  const raw = String(ref ?? '').trim();
  if (!raw) {
    return {
      ok: false,
      why: 'a decision attributed to the user needs the answer that carries it — pass --evidence Q-00N or --evidence events#seq=N',
    };
  }
  if (/^Q-\d+$/i.test(raw)) {
    const q = questionById(ctx.task, raw.toUpperCase());
    if (!q) return { ok: false, why: `${raw} is not a question on this task` };
    if (!q.answer) return { ok: false, why: `${raw} has not been answered yet (\`timc answer ${raw} "..."\`)` };
    return { ok: true, ref: q.evidence ?? raw };
  }
  const m = /^events#seq=(\d+)$/.exec(raw);
  if (m) {
    const ev = readEvents(ctx.P).find((e) => Number(e.seq) === Number(m[1]));
    if (!ev) return { ok: false, why: `no event #${m[1]} in the log` };
    if (ev.type !== 'ANSWER_RECEIVED') {
      return { ok: false, why: `event #${m[1]} is ${ev.type}, not an answer from the user` };
    }
    return { ok: true, ref: raw };
  }
  return { ok: false, why: `"${raw}" is not a question id or an event reference` };
}

/**
 * `timc decide "<question>" --decision "..." --reason "..." [--by user --evidence Q-001]`
 * Structured decisions live in task.yaml; decisions.md is rendered from them.
 */
export async function decide({ args, ctx }) {
  if (!ctx.task) { process.stderr.write('timc decide: no active task\n'); return 1; }
  const question = args.positional.join(' ').trim() || String(args.flags.question ?? '').trim();
  const decision = String(args.flags.decision ?? '').trim();
  const reason = String(args.flags.reason ?? '').trim();
  const type = String(args.flags.type ?? 'IMPLEMENTATION').toUpperCase();
  const by = String(args.flags.by ?? 'agent:orchestrator');

  if (!question) { process.stderr.write('timc decide: give the question that was decided\n'); return 1; }
  if (!decision) { process.stderr.write('timc decide: --decision "<what was decided>" is required\n'); return 1; }
  if (!reason) { process.stderr.write('timc decide: --reason "<why>" is required — a decision without a reason cannot be revisited\n'); return 1; }
  if (!DECISION_TYPES.includes(type)) {
    process.stderr.write(`timc decide: unknown --type "${type}" (${DECISION_TYPES.join(' | ')})\n`);
    return 1;
  }

  let evidence = null;
  if (by === 'user') {
    const check = resolveUserEvidence(ctx, args.flags.evidence);
    if (check.ok === false) { process.stderr.write(`timc decide: ${check.why}\n`); return 2; }
    evidence = check.ref;
  }

  const existing = Array.isArray(ctx.task.decisions) ? ctx.task.decisions : [];
  const id = `DEC-${String(existing.length + 1).padStart(3, '0')}`;
  const entry = {
    id,
    date: nowIso(),
    type,
    question,
    options: String(args.flags.options ?? '').split(';;').map((s) => s.trim()).filter(Boolean),
    decision,
    reason,
    decision_maker: by,
    evidence,
    affects: String(args.flags.affects ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    reversible: args.flags.reversible === false ? false : true,
    step: ctx.state?.currentStep ?? null,
    related_adr: args.flags.adr ? String(args.flags.adr) : null,
  };
  ctx.task.decisions = [...existing, entry];
  ctx.task = saveTask(ctx.P, ctx.task);
  appendEvent(ctx.P, {
    type: 'DECISION_RECORDED',
    task: ctx.task.id,
    step: entry.step,
    actor: by === 'user' ? 'human' : by,
    payload: { id, question, decision, evidence },
  });
  renderDecisions(ctx);
  commitState(ctx, `timc: ${ctx.task.id} ${id} recorded`);

  if (args.flags.json) { process.stdout.write(`${JSON.stringify(entry, null, 2)}\n`); return 0; }
  process.stdout.write([
    `${c.green('✓')} ${c.bold(id)} ${c.dim(`(${type}, ${by})`)}`,
    `  ${question}`,
    `  → ${decision}`,
    `  ${c.dim(`sabab / reason: ${reason}`)}`,
    evidence ? `  ${c.dim(`evidence: ${evidence}`)}` : '',
  ].filter(Boolean).join('\n') + '\n');
  return 0;
}

/** decisions.md is generated from task.yaml — one source, no drift. */
export function renderDecisions(ctx) {
  const list = Array.isArray(ctx.task?.decisions) ? ctx.task.decisions : [];
  const lines = [
    `# Decisions — ${ctx.task.id}`,
    '',
    '_Generated from `task.yaml` by `timc decide`. Do not edit by hand._',
    '',
  ];
  if (!list.length) lines.push('_No decisions recorded yet._');
  for (const d of list) {
    lines.push(`## ${d.id} — ${d.question}`);
    lines.push('');
    lines.push(`**Qaror / decision:** ${d.decision}`);
    lines.push('');
    lines.push(`**Sabab / reason:** ${d.reason}`);
    lines.push('');
    const meta = [
      `type: ${d.type}`,
      `by: ${d.decision_maker}`,
      d.evidence ? `evidence: ${d.evidence}` : null,
      `reversible: ${d.reversible}`,
      d.affects?.length ? `affects: ${d.affects.join(', ')}` : null,
      d.step ? `step: ${d.step}` : null,
      d.related_adr ? `adr: ${d.related_adr}` : null,
      `date: ${d.date}`,
    ].filter(Boolean);
    lines.push(meta.map((m) => `- ${m}`).join('\n'));
    if (d.options?.length) {
      lines.push('');
      lines.push(`Ko'rib chiqilgan / considered: ${d.options.join(' · ')}`);
    }
    lines.push('');
  }
  writeAtomic(path.join(ctx.task.__dir, 'decisions.md'), `${lines.join('\n')}\n`);
}

export default decide;
