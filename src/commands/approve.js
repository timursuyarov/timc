import { appendEvent, commitState, saveTask } from '../store.js';
import { nowIso } from '../io.js';
import { next as computeNext, planHash, readSpecMeta, stepsOf } from '../machine.js';
import { lastSeqWhere, requireHuman } from '../actor.js';
import { c } from '../render.js';

const PLAN_EVENTS = new Set(['STEP_ADDED', 'STEP_EDITED', 'STEP_REMOVED']);

/**
 * `timc approve plan` · `timc approve seam <SEAM-ID>`
 *
 * Approvals are the user's. From Claude Code they need --quote pointing at a
 * message the user sent after the thing being approved last changed.
 */
export async function approve({ args, ctx }) {
  if (!ctx.task) { process.stderr.write('timc approve: no active task\n'); return 1; }
  const what = args.positional[0];
  const t = ctx.task;
  t.approvals = t.approvals ?? {};

  if (what === 'plan') {
    if (!stepsOf(t).length) { process.stderr.write('timc approve plan: there is no plan yet — `timc step add` first\n'); return 1; }
    const after = lastSeqWhere(ctx.P, (e) => e.task === t.id
      && (PLAN_EVENTS.has(e.type) || (e.type === 'PHASE_STARTED' && e.payload?.phase === 'READY')));
    const who = await requireHuman(ctx, args, {
      action: 'Approving the plan',
      after,
      claim: `Approve this plan and start implementing: ${stepsOf(t).map((s) => `${s.id} ${s.delivers ?? s.goal}`).join('; ')}`,
    });
    if (who.ok === false) { process.stderr.write(`timc approve: ${who.why}\n`); return 2; }
    const hash = planHash(t);
    t.approvals.plan = { hash, at: nowIso(), by: who.by, quote: who.quote?.seq ?? null, steps: stepsOf(t).length };
    ctx.task = saveTask(ctx.P, t);
    appendEvent(ctx.P, { type: 'PLAN_APPROVED', task: t.id, actor: 'human', payload: { hash, quote: who.quote } });
    commitState(ctx, `timc: ${t.id} plan approved`);
    const hint = computeNext(ctx);
    process.stdout.write([
      `${c.green('✓')} plan tasdiqlandi / approved · ${stepsOf(t).length} step(s) · ${hash}`,
      who.quote ? c.dim(`  quote: events#seq=${who.quote.seq} — "${who.quote.text}"`) : '',
      c.dim('  Planni o\'zgartirish tasdiqni bekor qiladi / changing the plan voids this approval.'),
      '',
      `${c.bold('Keyingi / next:')} ${hint.title}`,
      hint.command ? `  ${c.cyan(hint.command)}` : '',
    ].filter(Boolean).join('\n') + '\n');
    return 0;
  }

  if (what === 'seam') {
    const id = args.positional[1];
    const seam = (readSpecMeta(t)?.seams ?? []).find((s) => s?.id === id);
    if (!seam) { process.stderr.write(`timc approve seam: ${id ?? '<SEAM-ID>'} is not declared in spec.md\n`); return 1; }
    const who = await requireHuman(ctx, args, {
      action: `Approving new seam ${id}`,
      latest: true,
      claim: `Add a new test seam ${id} at: ${seam.where}`,
    });
    if (who.ok === false) { process.stderr.write(`timc approve: ${who.why}\n`); return 2; }
    t.approvals.seams = { ...(t.approvals.seams ?? {}), [id]: { at: nowIso(), by: who.by, quote: who.quote?.seq ?? null, where: seam.where } };
    ctx.task = saveTask(ctx.P, t);
    appendEvent(ctx.P, { type: 'SEAM_APPROVED', task: t.id, actor: 'human', payload: { id, where: seam.where, quote: who.quote } });
    commitState(ctx, `timc: ${t.id} ${id} approved`);
    process.stdout.write(`${c.green('✓')} ${id} tasdiqlandi / approved — ${seam.where}\n`);
    return 0;
  }

  process.stderr.write('timc approve: plan | seam <SEAM-ID>\n');
  return 1;
}

export default approve;
