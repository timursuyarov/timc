import { appendEvent, commitState, saveTask } from '../store.js';
import { nowIso } from '../io.js';
import { frontier, next as computeNext } from '../machine.js';
import { createCheckpoint } from './checkpoint.js';
import { readStdinJson } from '../cli.js';
import { c } from '../render.js';
import { actorName, requireHuman } from '../actor.js';

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

/**
 * `timc ask "<question>" [--recommend "..."] [--depends Q-001] [--risk high]`
 *
 * A question is a node in the design tree, not a chat message: it carries the
 * agent's recommended answer and the questions it waits on. Facts are never
 * asked here — look them up. Only decisions belong to the user.
 */
export async function ask({ args, ctx }) {
  if (!requireTask(ctx)) return 1;
  const question = args.positional.join(' ').trim() || String(args.flags.question ?? '').trim();
  if (!question) { process.stderr.write('timc ask: give the question\n'); return 1; }
  const recommendation = String(args.flags.recommend ?? args.flags.recommendation ?? '').trim();
  if (!recommendation) {
    process.stderr.write('timc ask: --recommend "<your recommended answer>" is required — an interview question without a recommendation pushes the work back onto the user\n');
    return 1;
  }
  const existing = ctx.task.open_questions ?? [];
  const depends = String(args.flags.depends ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const d of depends) {
    if (!existing.some((q) => q.id === d)) { process.stderr.write(`timc ask: unknown dependency ${d}\n`); return 1; }
  }
  const id = `Q-${String(existing.length + 1).padStart(3, '0')}`;
  const round = Number(args.flags.round ?? currentRound(ctx.task));
  ctx.task.open_questions = [...existing, {
    id,
    question,
    recommendation,
    depends_on: depends,
    risk: String(args.flags.risk ?? 'medium'),
    round,
    asked: nowIso(),
    answer: null,
  }];
  const ev = appendEvent(ctx.P, { type: 'QUESTION_ASKED', task: ctx.task.id, payload: { id, question, recommendation, depends, round } });
  ctx.task.open_questions[ctx.task.open_questions.length - 1].asked_seq = ev.seq;

  const askable = frontier(ctx.task).length;
  setSuspend(ctx, 'AWAITING_USER', `${askable} question(s) waiting`, {
    question_id: id,
    resume_hint: `timc answer ${id} "<answer>"`,
  });
  if (args.flags.json) { process.stdout.write(`${JSON.stringify({ id, round, frontier: askable }, null, 2)}\n`); return 0; }
  process.stdout.write([
    `${c.yellow('?')} ${c.bold(id)} (round ${round}) — ${question}`,
    `  ${c.dim('➡ tavsiya / recommended:')} ${recommendation}`,
    depends.length ? `  ${c.dim(`waits on: ${depends.join(', ')}`)}` : '',
    `  ${c.cyan(`timc answer ${id} "<answer>"`)}   ${c.dim(`event #${ev.seq}`)}`,
  ].filter(Boolean).join('\n') + '\n');
  return 0;
}

/** Questions asked before any of them are answered belong to the same round. */
function currentRound(task) {
  const qs = task.open_questions ?? [];
  if (!qs.length) return 1;
  const maxRound = Math.max(...qs.map((q) => Number(q.round ?? 1)));
  const roundOpen = qs.some((q) => Number(q.round ?? 1) === maxRound && !q.answer);
  const roundAnswered = qs.some((q) => Number(q.round ?? 1) === maxRound && q.answer);
  return roundOpen && !roundAnswered ? maxRound : maxRound + 1;
}

export async function answer({ args, ctx }) {
  if (!requireTask(ctx)) return 1;
  const id = args.positional[0];
  const text = args.positional.slice(1).join(' ').trim() || String(args.flags.text ?? '').trim();
  if (!id || !text) { process.stderr.write('timc answer: timc answer <Q-ID> "<answer>"\n'); return 1; }
  const q = (ctx.task.open_questions ?? []).find((x) => x.id === id);
  if (!q) { process.stderr.write(`timc answer: ${id} not found\n`); return 1; }
  if (q.answer) { process.stderr.write(`timc answer: ${id} is already answered (${q.evidence ?? 'no event'})\n`); return 1; }
  // An answer is the user's. From Claude Code it must quote a message the user
  // sent after the question was asked; the quote travels with the answer.
  const who = await requireHuman(ctx, args, {
    action: `Answering ${id}`,
    after: Number(q.asked_seq ?? 0),
    claim: `To the question "${q.question}" the user answers: ${text}`,
  });
  if (who.ok === false) { process.stderr.write(`timc answer: ${who.why}\n`); return 2; }
  q.answer = text;
  q.answered = nowIso();
  if (who.quote) q.quote = who.quote.seq;
  // The verbatim answer is the only thing that can back a `decision_maker: user`.
  const ev = appendEvent(ctx.P, {
    type: 'ANSWER_RECEIVED',
    task: ctx.task.id,
    actor: 'human',
    payload: { id, question: q.question, answer: text, via: who.quote ? 'quote' : 'terminal', quote: who.quote },
  });
  q.evidence = `events#seq=${ev.seq}`;

  // The interview stays suspended while any question is still askable: one
  // answer does not end a round, an empty frontier ends the interview.
  const remaining = frontier(ctx.task);
  if (ctx.task.suspend?.kind === 'AWAITING_USER') {
    ctx.task.suspend = remaining.length
      ? { ...ctx.task.suspend, since: nowIso(), reason: `${remaining.length} question(s) waiting`, question_id: remaining[0].id, resume_hint: `timc answer ${remaining[0].id} "<answer>"` }
      : null;
  }
  ctx.task = saveTask(ctx.P, ctx.task);
  commitState(ctx, `timc: ${ctx.task.id} ${id} answered`);
  const hint = computeNext(ctx);
  process.stdout.write([
    `${c.green('✓')} ${id} javob yozildi / recorded (events#seq=${ev.seq})`,
    remaining.length
      ? `  ${c.dim(`${remaining.length} question(s) still askable: ${remaining.map((r) => r.id).join(', ')}`)}`
      : `  ${c.dim('frontier bo\'sh / frontier empty — the interview can close')}`,
    '',
    `${c.bold('Keyingi / next:')} ${hint.title}`,
    hint.command ? `  ${c.cyan(hint.command)}` : '',
  ].filter(Boolean).join('\n') + '\n');
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
  // Each suspension has its own way out; unblock only lifts a block.
  const other = {
    AWAITING_USER: 'the open questions are answered with `timc answer`',
    PAUSED: 'a pause ends with `timc resume`',
    PAUSED_LIMIT: 'a limit pause ends with `timc resume`',
    RECOVERY_REQUIRED: 'recovery ends with `timc doctor`',
    ABANDONED: 'an abandoned task stays abandoned — start a new one',
  }[was];
  if (other) { process.stderr.write(`timc unblock: ${ctx.task.id} is ${was}, not BLOCKED — ${other}\n`); return 2; }
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
  appendEvent(ctx.P, { type: 'TASK_ABANDONED', task: ctx.task.id, actor: actorName(), payload: { reason } });
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
