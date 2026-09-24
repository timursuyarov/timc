import { readStdinJson } from '../cli.js';
import { sha256 } from '../io.js';
import { appendEvent } from '../store.js';

/**
 * UserPromptSubmit hook: record what the user actually typed.
 *
 * This is the only way a USER_PROMPT event is created, and the Bash guard
 * denies calling it from the model's shell. User-only actions taken from
 * Claude Code (`timc answer`, `timc approve`, `--force`, …) must quote one of
 * these events, so "the user said so" always points at a real message.
 */
export async function prompt({ args, ctx }) {
  if (!args.flags.hook) {
    process.stderr.write('timc prompt: called by the UserPromptSubmit hook only\n');
    return 1;
  }
  const payload = await readStdinJson();
  const text = String(payload?.prompt ?? '').trim();
  if (!text) return 0;

  const ev = appendEvent(ctx.P, {
    type: 'USER_PROMPT',
    task: ctx.task?.id ?? null,
    actor: 'human',
    session: payload?.session_id ?? undefined,
    payload: { text: text.slice(0, 4000), sha256: sha256(text), prompt_id: payload?.prompt_id ?? null },
  });

  // Only worth the context when there is something to quote it for.
  if (ctx.task) {
    process.stdout.write(`${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `TIMC: this message is recorded as events#seq=${ev.seq}. `
          + `If it carries a user decision (an answer, an approval, a --force, a track change), pass --quote events#seq=${ev.seq}.`,
      },
    })}\n`);
  }
  return 0;
}

export default prompt;
