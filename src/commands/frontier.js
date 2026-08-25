import {
  CLOSED_STEP, blockedQuestions, depsSatisfied, frontier as questionFrontier, questionsOf, stepsOf,
} from '../machine.js';
import { c } from '../render.js';

/**
 * `timc frontier` — what can be worked on right now.
 *
 * The same idea in two places: interview questions whose prerequisites are
 * settled, and steps whose blocking tickets are done. Both come from declared
 * dependencies, so neither depends on anyone remembering the order.
 */
export async function frontier({ args, ctx }) {
  if (!ctx.task) { process.stderr.write('timc frontier: no active task\n'); return 1; }
  const task = ctx.task;

  const questions = questionFrontier(task).map((q) => ({
    id: q.id, round: q.round ?? 1, question: q.question, recommendation: q.recommendation ?? null, risk: q.risk ?? 'medium',
  }));
  const blocked = blockedQuestions(task);
  const answered = questionsOf(task).filter((q) => q.answer).length;

  const steps = stepsOf(task)
    .filter((s) => !CLOSED_STEP.has(s.status) && depsSatisfied(task, s))
    .map((s) => ({ id: s.id, status: s.status, delivers: s.delivers ?? s.goal, kind: s.kind ?? 'slice' }));
  const stepsBlocked = stepsOf(task)
    .filter((s) => !CLOSED_STEP.has(s.status) && !depsSatisfied(task, s))
    .map((s) => ({
      id: s.id,
      waiting_on: (s.depends_on ?? []).filter((d) => !CLOSED_STEP.has(stepsOf(task).find((x) => x.id === d)?.status)),
    }));

  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify({
      questions: { frontier: questions, blocked, answered, total: questionsOf(task).length },
      steps: { frontier: steps, blocked: stepsBlocked },
    }, null, 2)}\n`);
    return 0;
  }

  const L = [c.bold(`TIMC frontier · ${task.id} · ${task.phase}`)];
  L.push('');
  L.push(c.bold(`Savollar / questions  ${answered}/${questionsOf(task).length} answered`));
  if (!questions.length && !blocked.length) L.push(`  ${c.dim('— none —')}`);
  for (const q of questions) {
    L.push(`  ${c.yellow('?')} ${c.bold(q.id)} ${c.dim(`(round ${q.round}${q.risk === 'high' ? ', risk: high' : ''})`)} — ${q.question}`);
    if (q.recommendation) L.push(`      ${c.dim('➡')} ${q.recommendation}`);
    L.push(`      ${c.cyan(`timc answer ${q.id} "<answer>"`)}`);
  }
  for (const b of blocked) L.push(`  ${c.dim(`· ${b.id} waits on ${b.waiting_on.join(', ')}`)}`);

  L.push('');
  L.push(c.bold('Steplar / steps'));
  if (!steps.length && !stepsBlocked.length) L.push(`  ${c.dim('— none —')}`);
  for (const s of steps) L.push(`  ${c.cyan('▶')} ${c.bold(s.id)} ${c.dim(`(${s.kind})`)} — ${s.delivers}`);
  for (const s of stepsBlocked) L.push(`  ${c.dim(`· ${s.id} blocked by ${s.waiting_on.join(', ')}`)}`);

  process.stdout.write(`${L.join('\n')}\n`);
  return 0;
}

export default frontier;
