import { CLOSED_STEP, PHASE_GATE, actionableStep, phasePlan, progress, stepsOf } from './machine.js';
import { verifyStep } from './evidence.js';
import * as G from './git.js';

const useColor = () => !process.env.NO_COLOR && process.stdout.isTTY;
const ESC = '';
const wrap = (code, s) => (useColor() ? `${ESC}[${code}m${s}${ESC}[0m` : s);

export const c = {
  dim: (s) => wrap('2', s),
  bold: (s) => wrap('1', s),
  green: (s) => wrap('32', s),
  yellow: (s) => wrap('33', s),
  red: (s) => wrap('31', s),
  cyan: (s) => wrap('36', s),
};

export const MARKS = {
  done: c.green('✓'),
  running: c.cyan('▶'),
  pending: c.dim('○'),
  blocked: c.red('!'),
  user: c.yellow('?'),
  failed: c.red('×'),
  skipped: c.dim('–'),
};

function stepMark(status) {
  switch (status) {
    case 'done': return MARKS.done;
    case 'skipped': return MARKS.skipped;
    case 'in_progress': case 'validating': return MARKS.running;
    case 'needs_fix': return MARKS.failed;
    case 'blocked': return MARKS.blocked;
    default: return MARKS.pending;
  }
}

/**
 * The status screen. Two levels: user view and engineering view (-v).
 * @param {any} ctx @param {{verbose?: boolean, next?: any}} opts
 */
export function statusTree(ctx, opts = {}) {
  const { task } = ctx;
  const L = [];
  const rule = c.dim('─'.repeat(66));
  L.push(`${c.bold('TIMC')} ${rule.slice(0, 61)}`);

  const projectName = ctx.config?.project?.name ?? ctx.codeRoot.split(/[\\/]/).pop();
  if (!task) {
    L.push(`Loyiha / project: ${projectName}`);
    L.push('');
    L.push(`${MARKS.pending} Aktiv task yo'q / no active task`);
    L.push('');
    L.push(`${c.bold('Keyingi / next:')} timc new "<what you want to build>"`);
    return L.join('\n');
  }

  const prog = progress(task);
  const plan = phasePlan(task);
  const curIdx = plan.indexOf(task.phase);

  L.push(`Loyiha: ${projectName}${'  '}Task: ${c.bold(task.id)} · ${task.track}`);
  L.push(task.title);
  if (task.suspend) L.push(c.yellow(`SUSPENDED: ${task.suspend.kind} — ${task.suspend.reason ?? ''}`));
  L.push('');

  for (const [i, phase] of plan.entries()) {
    if (phase === 'CREATED') continue;
    const gate = task.gates?.[PHASE_GATE[phase]];
    // The mark comes from the recorded gate, never from position alone: a phase
    // that was jumped over must not look like a phase that passed.
    let mark = MARKS.pending;
    if (gate?.status === 'passed') mark = MARKS.done;
    else if (gate?.status === 'skipped') mark = MARKS.skipped;
    else if (gate?.status === 'forced' || gate?.status === 'bypassed') mark = MARKS.blocked;
    else if (i === curIdx) mark = MARKS.running;
    else if (i < curIdx) mark = MARKS.user;
    const at = gate?.at ? c.dim(` ${gate.at.slice(11, 16)}`) : '';
    const approved = gate?.approved_by ? c.dim(` (${gate.approved_by} ✓)`) : '';
    const flag = gate?.status === 'bypassed' ? c.yellow(' bypassed') : gate?.status === 'forced' ? c.yellow(' forced') : '';

    if (phase === 'BUILDING') {
      L.push(`  ${mark} ${pad(phase, 16)}${prog.total ? c.dim(`${prog.done}/${prog.total} · ${prog.pct}%`) : ''}`);
      for (const s of stepsOf(task)) {
        const detail = stepDetail(ctx, task, s);
        L.push(`      ${stepMark(s.status)} ${pad(s.id, 10)} ${pad(truncate(s.goal ?? '', 34), 34)} ${c.dim(detail)}`);
      }
    } else {
      L.push(`  ${mark} ${pad(phase, 16)}${at}${approved}${flag}${gate?.reason ? c.dim(` — ${gate.reason}`) : ''}`);
    }
  }

  L.push('');
  const facts = G.worktree(ctx.codeRoot);
  L.push(`${c.dim('Git:')}        ${G.branch(ctx.codeRoot)} @ ${G.shortHead(ctx.codeRoot) ?? '—'}` +
    (facts.dirty ? c.yellow(` (dirty: ${facts.files.length})`) : c.dim(' (clean)')));
  L.push(`${c.dim('Checkpoint:')} ${ctx.state.lastCheckpoint ?? '—'}`);

  if (opts.verbose) {
    L.push('');
    L.push(c.dim('— engineering view —'));
    L.push(`${c.dim('task file:')}  ${task.__file}`);
    L.push(`${c.dim('revision:')}   task=${task.revision ?? 0} state=${ctx.state.revision ?? 0} events=${ctx.state.lastEventSeq ?? 0}`);
    L.push(`${c.dim('signals:')}    ${(task.classification?.signals ?? []).join(', ') || '—'} (score ${task.classification?.score ?? 0})`);
    for (const s of stepsOf(task)) {
      const v = verifyStep(ctx.P, task, s);
      L.push(`  ${s.id} ${s.status}`);
      for (const cmd of s.validate ?? []) {
        const ok = v.satisfied.some((e) => e.command.includes(cmd.split(' ')[0]));
        L.push(`      ${ok ? MARKS.done : MARKS.pending} ${cmd}`);
      }
      for (const m of v.missing) L.push(`      ${c.dim(`↳ ${m.command}: ${m.why}`)}`);
    }
  }

  if (opts.next) {
    L.push('');
    L.push(`${c.bold('Keyingi / next:')} ${opts.next.title}`);
    if (opts.next.why) L.push(`  ${c.dim(opts.next.why)}`);
    if (opts.next.command) L.push(`  ${c.cyan(opts.next.command)}`);
  }
  return L.join('\n');
}

function stepDetail(ctx, task, step) {
  if (CLOSED_STEP.has(step.status)) {
    const n = (step.evidence ?? []).length;
    return step.status === 'skipped' ? `skipped: ${step.skip_reason ?? '—'}` : `evidence ${n}/${(step.validate ?? []).length}`;
  }
  if (step.status === 'in_progress' || step.status === 'validating') {
    const v = verifyStep(ctx.P, task, step);
    return v.ok ? 'validated — ready to close' : `waiting: ${v.missing[0]?.command ?? 'validation'}`;
  }
  if (step.status === 'needs_fix') return step.fail_reason ?? 'needs fix';
  const deps = (step.depends_on ?? []).filter((d) => !CLOSED_STEP.has(task.steps.find((x) => x.id === d)?.status));
  return deps.length ? `depends: ${deps.join(', ')}` : '';
}

const pad = (s, n) => String(s ?? '').padEnd(n);
const truncate = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
