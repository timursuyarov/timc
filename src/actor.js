import { readEvents } from './store.js';
import { checkQuote } from './jev.js';

/**
 * Who is running this command?
 *
 * Claude Code sets CLAUDECODE=1 in every shell it spawns for the Bash tool. A
 * human in their own terminal does not have it. The Bash guard denies commands
 * that touch this variable, so the model cannot shed it on the way in.
 * (Undocumented by Claude Code but stable; if it ever disappears, every caller
 * is treated as human — the pre-hardening behaviour, not a lockout.)
 */
export const isAgentShell = () => process.env.CLAUDECODE === '1';

/** Actor to stamp on events the caller is responsible for. */
export const actorName = () => (isAgentShell() ? 'orchestrator' : 'human');

/** Last USER_PROMPT event seq, or 0. */
export function lastPromptSeq(P) {
  const prompts = readEvents(P).filter((e) => e.type === 'USER_PROMPT');
  return prompts.length ? Number(prompts[prompts.length - 1].seq) : 0;
}

/**
 * Actions that belong to the user. From a human terminal they just run. From
 * Claude Code they need `--quote events#seq=N`: a USER_PROMPT event recorded by
 * the UserPromptSubmit hook — i.e. something the user actually typed — that is
 * newer than `after` (or, with `latest`, the user's most recent message).
 *
 * The quote alone cannot prove the user meant *this* action; it proves a real
 * message exists and puts its text next to the action in the audit trail. When
 * Jev is enabled it also reads the message against `claim` and refuses a quote
 * that does not authorise it ("hmm, not sure" is not an approval).
 *
 * @param {any} ctx
 * @param {any} args
 * @param {{action: string, after?: number, latest?: boolean, claim?: string}} opts
 * @returns {Promise<{ok: true, by: string, quote: {seq: number, text: string, jev?: any}|null} | {ok: false, why: string}>}
 */
export async function requireHuman(ctx, args, { action, after = 0, latest = false, claim = action }) {
  if (!isAgentShell()) return { ok: true, by: 'user', quote: null };

  const raw = String(args.flags.quote ?? '').trim();
  const howTo = `${action} is the user's call. Ask them to run it in their own terminal, `
    + 'or pass --quote events#seq=N pointing at the message where they said so '
    + '(every user message is recorded as a USER_PROMPT event).';
  if (!raw) return { ok: false, why: howTo };

  const m = /^(?:events#seq=)?(\d+)$/.exec(raw);
  if (!m) return { ok: false, why: `--quote "${raw}" is not events#seq=N. ${howTo}` };
  const seq = Number(m[1]);
  const events = readEvents(ctx.P);
  const ev = events.find((e) => Number(e.seq) === seq);
  if (!ev) return { ok: false, why: `no event #${seq} in the log` };
  if (ev.type !== 'USER_PROMPT') return { ok: false, why: `event #${seq} is ${ev.type}, not a message from the user` };
  if (seq <= after) return { ok: false, why: `event #${seq} predates what it would approve (needs a message after event #${after})` };
  if (latest) {
    const newest = lastPromptSeq(ctx.P);
    if (seq !== newest) return { ok: false, why: `event #${seq} is not the user's latest message (#${newest}) — quote the message that asked for this` };
  }
  const text = String(ev.payload?.text ?? '');
  const jev = await checkQuote(ctx, { claim, message: text.slice(0, 4000) });
  if (jev.verdict === 'reject') {
    return { ok: false, why: `event #${seq} does not read as the user authorising this — ${jev.why}. Ask the user directly, or they run it in their own terminal.` };
  }
  if (jev.verdict === 'warn') process.stderr.write(`  ! ${jev.why} — recorded; double-check with the user\n`);
  if (jev.verdict === 'skipped' && jev.why !== 'jev off') process.stderr.write(`  · quote not checked: ${jev.why}\n`);
  return {
    ok: true,
    by: 'user',
    quote: { seq, text: text.slice(0, 280), jev: jev.verdict === 'skipped' ? undefined : { verdict: jev.verdict, p: jev.p, kind: jev.kind } },
  };
}

/** Seq of the most recent event matching `pred`, or 0. */
export function lastSeqWhere(P, pred) {
  const evs = readEvents(P).filter(pred);
  return evs.length ? Number(evs[evs.length - 1].seq) : 0;
}
