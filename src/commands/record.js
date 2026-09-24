import { readStdinJson } from '../cli.js';
import { recordEvidence } from '../evidence.js';
import { gitFacts } from '../store.js';

/**
 * PostToolUse / PostToolUseFailure hook.
 *
 * This is the load-bearing anti-fake-report mechanism: the *harness* records
 * what ran, outside the model's control. The model cannot write here — writes
 * to .timc/runtime/** are denied by the guard hook.
 *
 * Exit status is inferred from which hook fired (PostToolUse = success,
 * PostToolUseFailure = failure). `timc run` records the real numeric code.
 */
export async function record({ args, ctx }) {
  const payload = args.flags.hook ? await readStdinJson() : null;
  const command = payload?.tool_input?.command ?? (args.rest.length ? args.rest.join(' ') : null);
  if (!command) return 0;
  if (payload && payload.tool_name && payload.tool_name !== 'Bash') return 0;

  const trimmed = String(command).trim();
  // `timc run` already writes a richer record with the real exit code.
  if (/^(timc|.*[\\/]bin[\\/]timc)\b/.test(trimmed)) return 0;
  // Ignore read-only noise so the evidence log stays about validation.
  if (/^(cd|ls|dir|cat|type|echo|pwd|git status|git diff|git log)\b/.test(trimmed)) return 0;

  const failed = Boolean(args.flags.failed) || payload?.hook_event_name === 'PostToolUseFailure';
  const raw = payload?.tool_output ?? payload?.tool_response ?? payload?.error ?? '';
  const output = typeof raw === 'string'
    ? raw
    : (raw?.text ?? raw?.message ?? [raw?.stdout, raw?.stderr].filter(Boolean).join('\n')) || JSON.stringify(raw);

  recordEvidence(ctx.P, {
    task: ctx.task?.id ?? null,
    step: ctx.state?.currentStep ?? null,
    command: trimmed,
    cwd: payload?.cwd ?? ctx.codeRoot,
    source: `hook:${payload?.hook_event_name ?? 'PostToolUse'}`,
    toolUseId: payload?.tool_use_id ?? null,
    exit: failed ? 1 : 0,
    stdout: output,
    git: gitFacts(ctx.codeRoot),
  });
  return 0;
}

export default record;
