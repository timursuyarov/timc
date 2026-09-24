import { appendEvent, commitState, saveTask } from '../store.js';
import { nowIso } from '../io.js';
import { allEvidence } from '../evidence.js';
import { next as computeNext, readSpecMeta, stepsOf, verificationProblem } from '../machine.js';
import { requireHuman } from '../actor.js';
import { verifyAdvice } from '../jev.js';
import { c } from '../render.js';

/**
 * `timc verify <AC-ID> [--evidence <EVIDENCE-ID>]`
 * `timc verify <AC-ID> --waive --reason "..."`   (the user's call)
 *
 * Links an acceptance criterion to evidence the harness recorded. Only green
 * evidence from a finished step that declares `--acceptance <AC-ID>` counts —
 * so a skipped step's criterion cannot borrow another step's test run.
 */
export async function verify({ args, ctx }) {
  if (!ctx.task) { process.stderr.write('timc verify: no active task\n'); return 1; }
  const t = ctx.task;
  const acId = args.positional[0];
  const ac = (readSpecMeta(t)?.acceptance_criteria ?? []).find((a) => a?.id === acId);
  if (!ac) { process.stderr.write(`timc verify: ${acId ?? '<AC-ID>'} is not an acceptance criterion in spec.md\n`); return 1; }
  t.verifications = t.verifications ?? {};

  if (args.flags.waive) {
    const reason = String(args.flags.reason ?? '').trim();
    if (!reason) { process.stderr.write('timc verify --waive: --reason "<why this criterion is out of scope>" is required\n'); return 1; }
    const who = await requireHuman(ctx, args, {
      action: `Waiving ${acId}`,
      latest: true,
      claim: `Drop acceptance criterion ${acId} ("${ac.text}") from this task, because: ${reason}`,
    });
    if (who.ok === false) { process.stderr.write(`timc verify: ${who.why}\n`); return 2; }
    t.verifications[acId] = { waived: true, reason, by: who.by, quote: who.quote?.seq ?? null, at: nowIso() };
    ctx.task = saveTask(ctx.P, t);
    appendEvent(ctx.P, { type: 'AC_WAIVED', task: t.id, actor: 'human', payload: { ac: acId, reason, quote: who.quote } });
    commitState(ctx, `timc: ${t.id} ${acId} waived`);
    process.stdout.write(`${c.yellow('!')} ${acId} kechildi / waived — ${reason}\n`);
    return 0;
  }

  const covering = stepsOf(t).filter((s) => s.acceptance === acId);
  if (!covering.length) { process.stderr.write(`timc verify: no step declares --acceptance ${acId}\n`); return 2; }
  const done = covering.filter((s) => s.status === 'done');
  if (!done.length) {
    process.stderr.write(`timc verify: ${acId} is covered by ${covering.map((s) => `${s.id} (${s.status})`).join(', ')} — none is done.\n`
      + '  If it was descoped, the user waives it: timc verify ' + acId + ' --waive --reason "..."\n');
    return 2;
  }

  const records = allEvidence(ctx.P).filter((e) => e.task === t.id && e.exit === 0 && done.some((s) => s.id === e.step));
  const wanted = args.flags.evidence ? String(args.flags.evidence) : null;
  const rec = wanted ? records.find((e) => e.id === wanted) : records[records.length - 1];
  if (!rec) {
    process.stderr.write(wanted
      ? `timc verify: ${wanted} is not passing evidence from a done step covering ${acId}\n`
      : `timc verify: no passing evidence from ${done.map((s) => s.id).join(', ')}\n`);
    return 2;
  }

  t.verifications[acId] = { evidence: rec.id, step: rec.step, command: rec.command, at: nowIso() };
  const problem = verificationProblem(ctx, t, acId);
  if (problem) { process.stderr.write(`timc verify: ${problem}\n`); return 2; }
  ctx.task = saveTask(ctx.P, t);
  appendEvent(ctx.P, { type: 'AC_VERIFIED', task: t.id, step: rec.step, payload: { ac: acId, evidence: rec.id } });
  commitState(ctx, `timc: ${t.id} ${acId} verified`);
  const advice = await verifyAdvice(ctx, { ac, step: stepsOf(t).find((s) => s.id === rec.step), command: rec.command });
  const hint = computeNext(ctx);
  process.stdout.write([
    `${c.green('✓')} ${acId} tasdiqlandi / verified — ${rec.id} (${rec.step}: ${rec.command}, exit 0)`,
    advice ? `  ${c.yellow('!')} ${advice}` : '',
    '',
    `${c.bold('Keyingi / next:')} ${hint.title}`,
    hint.command ? `  ${c.cyan(hint.command)}` : '',
  ].filter(Boolean).join('\n') + '\n');
  return 0;
}

export default verify;
