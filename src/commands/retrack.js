import path from 'node:path';
import fs from 'node:fs';
import { appendEvent, commitState, saveTask } from '../store.js';
import { nowIso, writeAtomic } from '../io.js';
import { retrackAllowed, TRACKS } from '../classify.js';
import { PHASES, PHASE_GATE, next as computeNext, phasePlan } from '../machine.js';
import { requireHuman } from '../actor.js';
import * as T from '../templates.js';
import { c } from '../render.js';

/**
 * `timc retrack <trivial|standard|high_risk> --reason "..."`
 *
 * Raising the track is always allowed — it only adds gates. Lowering it removes
 * gates, so it is the user's call. After an upgrade the earliest phase the new
 * track requires but the task never passed is reopened.
 */
export async function retrack({ args, ctx }) {
  if (!ctx.task) { process.stderr.write('timc retrack: no active task\n'); return 1; }
  const t = ctx.task;
  const to = String(args.positional[0] ?? '');
  if (!TRACKS.includes(to)) { process.stderr.write(`timc retrack: ${TRACKS.join(' | ')}\n`); return 1; }
  const reason = String(args.flags.reason ?? '').trim();
  if (!reason) { process.stderr.write('timc retrack: --reason "<why>" is required\n'); return 1; }
  const from = t.track;
  if (from === to) { process.stdout.write(`${t.id} is already ${to}\n`); return 0; }

  const downgrade = TRACKS.indexOf(to) < TRACKS.indexOf(from);
  let who = { ok: true, by: 'agent:orchestrator', quote: null };
  if (downgrade) {
    who = await requireHuman(ctx, args, {
      action: `Lowering the track to ${to}`,
      latest: true,
      claim: `Treat ${t.id} "${t.title}" as ${to} instead of ${from} (fewer gates), because: ${reason}`,
    });
    if (who.ok === false) { process.stderr.write(`timc retrack: ${who.why}\n`); return 2; }
  }
  const rule = retrackAllowed(from, to, { byUser: who.by === 'user' });
  if (!rule.allowed) { process.stderr.write(`timc retrack: ${rule.reason}\n`); return 2; }

  t.track = to;
  // A task that started trivial has no interview/spec/plan to work in.
  if (from === 'trivial') {
    const stub = { id: t.id, title: t.title };
    for (const [name, make] of [['interview.md', T.interviewMd], ['spec.md', T.specMd], ['plan.md', T.planMd]]) {
      const file = path.join(t.__dir, name);
      if (!fs.existsSync(file)) writeAtomic(file, make(stub));
    }
  }

  // Reopen the first required phase whose gate was never passed.
  const plan = phasePlan(t);
  const at = PHASES.indexOf(t.phase);
  const reopen = plan.find((p) => PHASES.indexOf(p) > 0 && PHASES.indexOf(p) <= at
    && PHASE_GATE[p] && t.phase !== p && t.gates?.[PHASE_GATE[p]]?.status !== 'passed');
  const fromPhase = t.phase;
  if (!downgrade && reopen) t.phase = reopen;

  ctx.task = saveTask(ctx.P, t);
  appendEvent(ctx.P, {
    type: 'TRACK_ASSIGNED',
    task: t.id,
    actor: downgrade ? 'human' : 'orchestrator',
    payload: { from, to, by: who.by, reason, quote: who.quote, reopened: !downgrade && reopen ? reopen : null, at: nowIso() },
  });
  commitState(ctx, `timc: ${t.id} ${from} → ${to}`);
  const hint = computeNext(ctx);
  process.stdout.write([
    `${c.green('✓')} ${t.id} track: ${from} → ${c.bold(to)} — ${reason}`,
    !downgrade && reopen ? `  ${c.yellow('!')} ${fromPhase} → ${reopen}: bu faza hali o'tilmagan / reopened, never passed` : '',
    '',
    `${c.bold('Keyingi / next:')} ${hint.title}`,
    hint.command ? `  ${c.cyan(hint.command)}` : '',
  ].filter(Boolean).join('\n') + '\n');
  return 0;
}

export default retrack;
