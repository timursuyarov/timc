import path from 'node:path';
import { buildBrief, DEFAULT_BUDGET_TOKENS } from '../brief.js';
import { next as computeNext } from '../machine.js';
import { ensureDir, writeAtomic, nowIso, appendNdjson } from '../io.js';

/**
 * `timc brief` — the deterministic context pack.
 * With `--hook` it is emitted as `additionalContext` from the SessionStart /
 * PostCompact hook, which is what makes invariant 1 mechanical: every fresh
 * session starts from durable state instead of remembering to look for it.
 */
export async function brief({ args, ctx }) {
  const hint = computeNext(ctx);
  const budget = Number(args.flags.budget ?? DEFAULT_BUDGET_TOKENS) || DEFAULT_BUDGET_TOKENS;
  const built = buildBrief(ctx, {
    budget,
    nextHint: `${hint.title}${hint.command ? ` → ${hint.command}` : ''}`,
  });

  // Keep the exact text that was injected, for audit.
  try {
    ensureDir(ctx.P.briefsDir);
    const stamp = nowIso().replace(/[:]/g, '-');
    writeAtomic(path.join(ctx.P.briefsDir, `${ctx.task?.phase ?? 'none'}-${stamp}.md`), built.text);
    if (args.flags.hook) {
      appendNdjson(ctx.P.sessions, {
        ts: nowIso(),
        session: process.env.CLAUDE_SESSION_ID ?? null,
        task: ctx.task?.id ?? null,
        phase: ctx.task?.phase ?? null,
        tokens: built.tokens,
        dropped: built.dropped.map((d) => d.name),
      });
    }
  } catch { /* auditing must never block the brief */ }

  if (args.flags.hook) {
    process.stdout.write(`${JSON.stringify({ additionalContext: built.text })}\n`);
    return 0;
  }
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify(built, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(`${built.text}\n`);
  return 0;
}

export default brief;
