import { next as computeNext, progress, stepsOf } from '../machine.js';
import { statusTree, c } from '../render.js';
import { gitFacts } from '../store.js';

export async function status({ args, ctx }) {
  const hint = computeNext(ctx);
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(snapshot(ctx, hint), null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${statusTree(ctx, { verbose: Boolean(args.flags.verbose), next: hint })}\n`);
  return 0;
}

/** `timc next` — the machine-readable authority agents are told to obey. */
export async function next({ args, ctx }) {
  const hint = computeNext(ctx);
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify({ ...hint, task: ctx.task?.id ?? null, phase: ctx.task?.phase ?? null }, null, 2)}\n`);
    return 0;
  }
  const L = [`${c.bold(hint.title)}`];
  if (hint.why) L.push(`  ${hint.why}`);
  if (hint.missing?.length) for (const m of hint.missing) L.push(`  ${c.yellow('·')} ${m}`);
  if (hint.command) L.push(`  ${c.cyan(hint.command)}`);
  process.stdout.write(`${L.join('\n')}\n`);
  return 0;
}

export function snapshot(ctx, hint) {
  const t = ctx.task;
  return {
    project: ctx.config?.project?.name ?? null,
    task: t
      ? {
        id: t.id,
        title: t.title,
        track: t.track,
        phase: t.phase,
        suspend: t.suspend ?? null,
        revision: t.revision ?? 0,
        progress: progress(t),
        steps: stepsOf(t).map((s) => ({
          id: s.id, status: s.status, goal: s.goal, depends_on: s.depends_on ?? [], validate: s.validate ?? [],
        })),
      }
      : null,
    state: {
      revision: ctx.state?.revision ?? 0,
      lastEventSeq: ctx.state?.lastEventSeq ?? 0,
      lastCheckpoint: ctx.state?.lastCheckpoint ?? null,
    },
    git: gitFacts(ctx.codeRoot),
    next: hint,
  };
}

export default status;
