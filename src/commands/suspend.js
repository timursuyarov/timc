import { appendEvent, commitState, saveTask } from '../store.js';
import { nowIso } from '../io.js';
import { next as computeNext } from '../machine.js';
import { createCheckpoint } from './checkpoint.js';
import { readStdinJson } from '../cli.js';
import { c } from '../render.js';

/** Suspension is orthogonal to the phase: the phase never changes here. */
function setSuspend(ctx, kind, reason, extra = {}) {
  ctx.task.suspend = { kind, since: nowIso(), reason, ...extra };
  ctx.task = saveTask(ctx.P, ctx.task);
  appendEvent(ctx.P, { type: 'SUSPENDED', task: ctx.task.id, payload: { kind, reason } });
  createCheckpoint(ctx, { reason: `SUSPENDED:${kind}` });
  commitState(ctx, `timc: ${ctx.task.id} suspended (${kind})`);
}

function requireTask(ctx) {
  if (!ctx.task) { process.stderr.write('timc: no active task\n'); return false; }
  return true;
}

export async function ask({ args, ctx }) {
  if (!requireTask(ctx)) return 1;
  const question = args.positional.join(' ').trim() || String(args.flags.question ?? '').trim();
  if (!question) { process.stderr.write('timc ask: give the question\n'); return 1; }
  const id = `Q-${String((ctx.task.open_questions?.length ?? 0) + 1).padStart(3, '0')}`;
  ctx.task.open_questions = [...(ctx.task.open_questions ?? []), {
    id, question, risk: String(args.flags.risk ?? 'medium'), asked: nowIso(), answer: null,
  }];
  const ev = appendEvent(ctx.P, { type: 'QUESTION_ASKED', task: ctx.task.id, payload: { id, question } });
  setSuspend(ctx, 'AWAITING_USER', question, { question_id: id, resume_hint: `timc answer ${id} "<answer>"` });
  process.stdout.write(`${c.yellow('?')} ${id} — ${question}\n  ${c.cyan(`timc answer ${id} "<answer>"`)}\n  ${c.dim(`event #${ev.seq}`)}\n`);
  return 0;
}

export async function answer({ args, ctx }) {
  if (!requireTask(ctx)) return 1;
  const id = args.positional[0];
  const text = args.positional.slice(1).join(' ').trim() || String(args.flags.text ?? '').trim();
  if (!id || !text) { process.stderr.write('timc answer: timc answer <Q-ID> "<answer>"\n'); return 1; }
  const q = (ctx.task.open_questions ?? []).find((x) => x.id === id);
  if (!q) { process.stderr.write(`timc answer: ${id} not found\n`); return 1; }
  q.answer = text;
  q.answered = nowIso();
  // The verbatim answer is the only thing that can back a `decision_maker: user`.
  const ev = appendEvent(ctx.P, { type: 'ANSWER_RECEIVED', task: ctx.task.id, actor: 'human', payload: { id, question: q.question, answer: text } });
  q.evidence = `events#seq=${ev.seq}`;
  if (ctx.task.suspend?.kind === 'AWAITING_USER' && ctx.task.suspend.question_id === id) ctx.task.suspend = null;
  ctx.task = saveTask(ctx.P, ctx.task);
  commitState(ctx, `timc: ${ctx.task.id} ${id} answered`);
  const hint = computeNext(ctx);
  process.stdout.write(`${c.green('✓')} ${id} javob yozildi / recorded (events#seq=${ev.seq})\n\n${c.bold('Keyingi / next:')} ${hint.title}\n${hint.command ? `  ${c.cyan(hint.command)}\n` : ''}`);
  return 0;
}

export async function block({ args, ctx }) {
  if (!requireTask(ctx)) return 1;
  const reason = args.positional.join(' ').trim() || String(args.flags.reason ?? '').trim();
  if (!reason) { process.stderr.write('timc block: give the reason\n'); return 1; }
  setSuspend(ctx, 'BLOCKED', reason, { resume_hint: 'timc unblock' });
  process.stdout.write(`${c.red('!')} BLOCKED — ${reason}\n`);
  return 0;
}

export async function unblock({ args, ctx }) {
  if (!requireTask(ctx)) return 1;
  const was = ctx.task.suspend?.kind ?? null;
  ctx.task.suspend = null;
  ctx.task = saveTask(ctx.P, ctx.task);
  appendEvent(ctx.P, { type: 'RESUMED', task: ctx.task.id, payload: { from: was } });
  commitState(ctx, `timc: ${ctx.task.id} unblocked`);
  const hint = computeNext(ctx);
  process.stdout.write(`${c.green('✓')} suspension cleared (${was ?? 'none'})\n${hint.command ? `  ${c.cyan(hint.command)}\n` : ''}`);
  return 0;
}

export async function pause({ args, ctx }) {
  if (!requireTask(ctx)) return 1;
  const reason = args.positional.join(' ').trim() || String(args.flags.reason ?? 'paused by user');
  setSuspend(ctx, 'PAUSED', reason, { resume_hint: 'timc resume' });
  process.stdout.write(`${c.yellow('||')} PAUSED — ${reason}\n  ${c.cyan('timc resume')}\n`);
  return 0;
}

export async function abandon({ args, ctx }) {
  if (!requireTask(ctx)) return 1;
  const reason = args.positional.join(' ').trim() || String(args.flags.reason ?? '').trim();
  if (!reason) { process.stderr.write('timc abandon: --reason "<why>" is required\n'); return 1; }
  setSuspend(ctx, 'ABANDONED', reason);
  appendEvent(ctx.P, { type: 'TASK_ABANDONED', task: ctx.task.id, actor: 'human', payload: { reason } });
  process.stdout.write(`${c.dim('×')} ${ctx.task.id} abandoned — ${reason}\n`);
  return 0;
}

/**
 * StopFailure hook: the turn ended on an API error. Rate limits and billing
 * errors become PAUSED_LIMIT with a clean resume point instead of an ambiguous
 * half-finished state.
 */
export async function suspend({ args, ctx }) {
  const payload = args.flags.hook ? await readStdinJson() : null;
  if (!ctx.task) return 0;
  const blob = JSON.stringify(payload ?? {}).toLowerCase();
  const limit = /rate_limit|overloaded|billing|quota|usage limit|insufficient/.test(blob);
  const kind = limit ? 'PAUSED_LIMIT' : 'PAUSED';
  const reason = limit ? 'provider limit reached' : (payload?.error ?? 'session ended on an error');
  setSuspend(ctx, kind, String(reason), { resume_hint: 'timc resume' });
  if (!args.flags.hook) process.stdout.write(`${c.yellow('||')} ${kind} — ${reason}\n`);
  return 0;
}

export default suspend;
