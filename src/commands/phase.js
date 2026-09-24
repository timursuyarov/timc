import { appendEvent, commitState, saveTask } from '../store.js';
import { PHASES, PHASE_GATE, canAdvance, next as computeNext, phasePlan, planAdvisories } from '../machine.js';
import { nowIso } from '../io.js';
import { c } from '../render.js';
import { createCheckpoint } from './checkpoint.js';
import { requireHuman } from '../actor.js';

export async function phase({ args, ctx }) {
  const sub = args.positional[0] ?? 'show';
  if (!ctx.task) { process.stderr.write('timc phase: no active task\n'); return 1; }
  switch (sub) {
    case 'advance': return advance({ args, ctx });
    case 'set': return set({ args, ctx, to: args.positional[1] });
    case 'show': default: return show({ args, ctx });
  }
}

async function show({ args, ctx }) {
  const plan = phasePlan(ctx.task);
  const adv = canAdvance(ctx, ctx.task);
  if (args.flags.json) { process.stdout.write(`${JSON.stringify({ phase: ctx.task.phase, plan, advance: adv }, null, 2)}\n`); return 0; }
  process.stdout.write([
    `phase:  ${c.bold(ctx.task.phase)}`,
    `plan:   ${plan.join(' → ')}`,
    `next:   ${adv.to ?? '—'} ${adv.ok ? c.green('(gate satisfied)') : c.yellow('(gate not satisfied)')}`,
    ...adv.missing.map((m) => `  ${c.yellow('·')} ${m}`),
  ].join('\n') + '\n');
  return 0;
}

async function advance({ args, ctx }) {
  const adv = canAdvance(ctx, ctx.task);
  if (!adv.to) { process.stdout.write(`${ctx.task.id} is already in its final phase (${ctx.task.phase})\n`); return 0; }
  // A suspended task does not move, whatever its gate says.
  const s = ctx.task.suspend;
  if (s && !adv.missing.some((m) => m.startsWith('task is suspended'))) {
    adv.missing.unshift(`task is suspended (${s.kind}${s.reason ? `: ${s.reason}` : ''}) — \`timc next\` says how to resolve it`);
    adv.ok = false;
  }
  if (!adv.ok) {
    const L = [c.red(`× ${ctx.task.phase} → ${adv.to} bloklandi / blocked`)];
    for (const m of adv.missing) L.push(`  ${c.yellow('·')} ${m}`);
    process.stderr.write(`${L.join('\n')}\n`);
    appendEvent(ctx.P, { type: 'GATE_FAILED', task: ctx.task.id, payload: { from: ctx.task.phase, to: adv.to, missing: adv.missing } });
    return 2;
  }
  return move({ args, ctx, to: adv.to, forced: false });
}

async function set({ args, ctx, to }) {
  const target = String(to ?? '').toUpperCase();
  if (!PHASES.includes(target)) {
    process.stderr.write(`timc phase set: unknown phase "${to}"\n  known: ${PHASES.join(', ')}\n`);
    return 1;
  }
  if (!args.flags.force) {
    process.stderr.write('timc phase set: this skips gates — pass --force and --reason "<why>"\n');
    return 2;
  }
  const reason = String(args.flags.reason ?? '').trim();
  if (!reason) { process.stderr.write('timc phase set: --reason "<why the gate does not apply>" is required\n'); return 1; }
  // Skipping a gate is the user's decision, never the agent's own shortcut.
  const who = await requireHuman(ctx, args, {
    action: `Forcing ${ctx.task.phase} → ${target}`,
    latest: true,
    claim: `Skip the gates and move ${ctx.task.id} from ${ctx.task.phase} to ${target}, because: ${reason}`,
  });
  if (who.ok === false) { process.stderr.write(`timc phase set: ${who.why}\n`); return 2; }
  const quote = who.quote ? ` [quote events#seq=${who.quote.seq}]` : '';
  return move({ args, ctx, to: target, forced: true, reason: `${reason}${quote}`, forcedBy: who.by });
}

function move({ args, ctx, to, forced, reason = null, forcedBy = null }) {
  const from = ctx.task.phase;
  const gateKey = PHASE_GATE[from];
  ctx.task.gates = ctx.task.gates ?? {};
  if (gateKey && from !== 'CREATED') {
    ctx.task.gates[gateKey] = {
      status: forced ? 'forced' : 'passed',
      at: nowIso(),
      approved_by: forcedBy ?? undefined,
      reason: reason ?? undefined,
    };
  }
  // Phases that are jumped over are recorded explicitly — never left blank,
  // because a blank gate would render as "passed" and that would be a lie.
  const plan = phasePlan(ctx.task);
  for (const jumped of PHASES.slice(PHASES.indexOf(from) + 1, PHASES.indexOf(to))) {
    const key = PHASE_GATE[jumped];
    if (!key || ctx.task.gates[key]) continue;
    ctx.task.gates[key] = plan.includes(jumped)
      ? { status: 'bypassed', at: nowIso(), reason: reason ?? 'jumped over without passing its gate' }
      : { status: 'skipped', at: nowIso(), reason: `not part of the ${ctx.task.track} track` };
  }
  ctx.task.phase = to;
  ctx.task.handoffs = [...(ctx.task.handoffs ?? []), {
    phase: from,
    status: forced ? 'forced' : 'completed',
    at: nowIso(),
    session: process.env.CLAUDE_SESSION_ID ?? null,
    next_phase: to,
    reason: reason ?? undefined,
  }];
  ctx.task = saveTask(ctx.P, ctx.task);
  appendEvent(ctx.P, { type: 'PHASE_COMPLETED', task: ctx.task.id, actor: forced ? 'human' : undefined, payload: { from, to, forced, reason } });
  appendEvent(ctx.P, { type: 'PHASE_STARTED', task: ctx.task.id, payload: { phase: to } });
  createCheckpoint(ctx, { reason: 'PHASE_STARTED' });
  commitState(ctx, `timc: ${ctx.task.id} ${from} → ${to}`);

  const hint = computeNext(ctx);
  const notes = to === 'READY' || from === 'PLANNING' ? planAdvisories(ctx.task) : [];
  if (args.flags.json) { process.stdout.write(`${JSON.stringify({ from, to, forced, advisories: notes, next: hint }, null, 2)}\n`); return 0; }
  process.stdout.write([
    `${forced ? c.yellow('!') : c.green('✓')} ${from} → ${c.bold(to)}${forced ? c.yellow(' (forced)') : ''}`,
    ...notes.map((n) => `  ${c.yellow('!')} ${n}`),
    '',
    `${c.bold('Keyingi / next:')} ${hint.title}`,
    hint.why ? `  ${c.dim(hint.why)}` : '',
    hint.command ? `  ${c.cyan(hint.command)}` : '',
  ].filter(Boolean).join('\n') + '\n');
  return 0;
}

export default phase;
