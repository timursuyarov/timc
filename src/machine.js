import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { readText } from './io.js';
import { verifyStep } from './evidence.js';
import * as G from './git.js';

/**
 * The phase machine. Pure functions only: every guard here is decidable from
 * files on disk plus git, so "the agent said it is done" is never evidence.
 */

export const PHASES = [
  'CREATED', 'FRAMING', 'SPECIFYING', 'ARCH_REVIEW', 'PLANNING', 'READY',
  'BUILDING', 'VERIFYING', 'REVIEWING', 'DOCUMENTING', 'LANDING', 'DONE',
];

export const SUSPENDS = [
  'AWAITING_USER', 'BLOCKED', 'PAUSED', 'PAUSED_LIMIT', 'RECOVERY_REQUIRED', 'ABANDONED',
];

export const STEP_STATUSES = [
  'pending', 'ready', 'in_progress', 'validating', 'needs_fix', 'done', 'skipped', 'blocked',
];

export const CLOSED_STEP = new Set(['done', 'skipped']);

/** phase -> gate key recorded on the task once the phase completes. */
export const PHASE_GATE = {
  FRAMING: 'interview',
  SPECIFYING: 'spec',
  ARCH_REVIEW: 'arch_review',
  PLANNING: 'plan',
  READY: 'ready',
  BUILDING: 'build',
  VERIFYING: 'verify',
  REVIEWING: 'review',
  DOCUMENTING: 'docs',
  LANDING: 'land',
};

const TRACK_PHASES = {
  trivial: ['CREATED', 'BUILDING', 'LANDING', 'DONE'],
  standard: ['CREATED', 'FRAMING', 'SPECIFYING', 'PLANNING', 'READY', 'BUILDING', 'VERIFYING', 'LANDING', 'DONE'],
  high_risk: [
    'CREATED', 'FRAMING', 'SPECIFYING', 'ARCH_REVIEW', 'PLANNING', 'READY',
    'BUILDING', 'VERIFYING', 'REVIEWING', 'DOCUMENTING', 'LANDING', 'DONE',
  ],
};

/** Active phases for a task, widened when the spec declares risky flags. */
export function phasePlan(task) {
  const base = [...(TRACK_PHASES[task?.track] ?? TRACK_PHASES.standard)];
  const spec = readSpecMeta(task);
  if (spec?.schema_change || spec?.public_api_change || spec?.migration_required) {
    if (!base.includes('ARCH_REVIEW')) base.splice(base.indexOf('SPECIFYING') + 1, 0, 'ARCH_REVIEW');
  }
  if (spec?.security_relevant && !base.includes('REVIEWING')) {
    base.splice(base.indexOf('VERIFYING') + 1, 0, 'REVIEWING');
  }
  return base;
}

export function nextPhase(task) {
  const plan = phasePlan(task);
  const i = plan.indexOf(task.phase);
  if (i === -1) return plan[0] ?? null;
  return plan[i + 1] ?? null;
}

export function artifact(task, name) {
  return task?.__dir ? path.join(task.__dir, name) : null;
}

function artifactText(task, name) {
  const p = artifact(task, name);
  return p ? readText(p, null) : null;
}

/** Parse `---\n...\n---` front matter from a markdown artifact. */
export function frontMatter(text) {
  if (!text) return null;
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  try { return YAML.parse(m[1]); } catch { return null; }
}

export function readSpecMeta(task) {
  return frontMatter(artifactText(task, 'spec.md'));
}

/**
 * Split a markdown artifact into `## heading` -> body, keyed lower-case.
 * @param {string|null} text
 * @returns {Record<string, string>}
 */
export function sections(text) {
  /** @type {Record<string, string>} */
  const map = {};
  for (const part of String(text ?? '').split(/^##\s+/m).slice(1)) {
    const nl = part.indexOf('\n');
    const title = (nl === -1 ? part : part.slice(0, nl)).trim().toLowerCase();
    map[title] = nl === -1 ? '' : part.slice(nl + 1);
  }
  return map;
}

/** True when a section holds something other than placeholders and comments. */
export function hasContent(body) {
  return String(body ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l
      && !l.startsWith('_')
      && !l.startsWith('<!--')
      && !l.startsWith('#')
      && !/^[-*]?\s*(…|\.\.\.|TODO|tbd)$/i.test(l))
    .length > 0;
}

export const stepsOf = (task) => (Array.isArray(task?.steps) ? task.steps : []);
export const stepById = (task, id) => stepsOf(task).find((s) => s.id === id) ?? null;

export function depsSatisfied(task, step) {
  const deps = Array.isArray(step.depends_on) ? step.depends_on : [];
  return deps.every((d) => CLOSED_STEP.has(stepById(task, d)?.status));
}

/** The one step a worker should touch next, or null. */
export function actionableStep(task) {
  const steps = stepsOf(task);
  return steps.find((s) => s.status === 'in_progress' || s.status === 'validating')
    ?? steps.find((s) => s.status === 'needs_fix' && depsSatisfied(task, s))
    ?? steps.find((s) => (s.status === 'pending' || s.status === 'ready') && depsSatisfied(task, s))
    ?? null;
}

export function allStepsClosed(task) {
  const steps = stepsOf(task);
  return steps.length > 0 && steps.every((s) => CLOSED_STEP.has(s.status));
}

function hasCycle(task) {
  const steps = stepsOf(task);
  const byId = new Map(steps.map((s) => [s.id, s]));
  const seen = new Map();
  const visit = (id) => {
    const mark = seen.get(id);
    if (mark === 'done') return false;
    if (mark === 'open') return true;
    seen.set(id, 'open');
    for (const d of byId.get(id)?.depends_on ?? []) {
      if (byId.has(d) && visit(d)) return true;
    }
    seen.set(id, 'done');
    return false;
  };
  return steps.some((s) => visit(s.id));
}

/**
 * Guards keyed by the phase being entered.
 * @type {Record<string, (ctx: any, task: any) => string[]>}
 */
export const GUARDS = {
  SPECIFYING(ctx, task) {
    const missing = [];
    const text = artifactText(task, 'interview.md');
    if (!text || text.trim().length < 40) return ['interview.md is empty — run the Interview phase'];
    const s = sections(text);
    if (!('confirmed facts' in s)) missing.push('interview.md needs a "## Confirmed facts" section');
    else if (!hasContent(s['confirmed facts'])) {
      missing.push('interview.md: "Confirmed facts" is still empty — record what the interview actually established');
    }
    if (!('open questions' in s)) missing.push('interview.md needs an "## Open questions" section');
    else if (/^\s*(?:[-*]\s+)?risk:\s*high\b/im.test(s['open questions'])) {
      missing.push('an open question is still marked risk: high — resolve it or lower the risk');
    }
    return missing;
  },
  ARCH_REVIEW(ctx, task) {
    return artifactText(task, 'spec.md') ? [] : ['spec.md is missing'];
  },
  PLANNING(ctx, task) {
    const missing = [];
    const text = artifactText(task, 'spec.md');
    if (!text || text.trim().length < 40) return ['spec.md is empty — run the Specification phase'];
    const meta = frontMatter(text);
    const acs = Array.isArray(meta?.acceptance_criteria) ? meta.acceptance_criteria : [];
    if (!acs.length) missing.push('spec.md front matter needs at least one acceptance_criteria entry');
    const unknown = (meta?.assumptions ?? []).filter((a) => String(a?.level).toUpperCase() === 'UNKNOWN');
    if (unknown.length) missing.push(`${unknown.length} assumption(s) still UNKNOWN — confirm or downgrade the risk`);
    return missing;
  },
  READY(ctx, task) {
    const missing = [];
    const steps = stepsOf(task);
    if (!steps.length) missing.push('no steps — add them with `timc step add`');
    for (const s of steps) {
      if (!s.goal) missing.push(`${s.id}: goal is missing`);
      if (!Array.isArray(s.touches) || !s.touches.length) missing.push(`${s.id}: touches[] is missing (needed for drift detection)`);
      if (!Array.isArray(s.validate) || !s.validate.length) missing.push(`${s.id}: validate[] is missing (nothing could prove it works)`);
    }
    if (hasCycle(task)) missing.push('step dependencies contain a cycle');
    const acs = (readSpecMeta(task)?.acceptance_criteria ?? []).map((a) => a.id).filter(Boolean);
    const covered = new Set(steps.map((s) => s.acceptance).filter(Boolean));
    const orphan = acs.filter((id) => !covered.has(id));
    if (orphan.length) missing.push(`acceptance criteria not covered by any step: ${orphan.join(', ')}`);
    return missing;
  },
  BUILDING(ctx, task) {
    const missing = [];
    if (task.suspend) missing.push(`task is suspended (${task.suspend.kind}) — resolve it first`);
    if (task.track !== 'trivial' && !stepsOf(task).length) {
      missing.push('no steps — a non-trivial task needs a plan before implementation');
    }
    return missing;
  },
  VERIFYING(ctx, task) {
    const missing = [];
    if (!stepsOf(task).length) missing.push('there are no steps — add them with `timc step add`');
    else if (!allStepsClosed(task)) missing.push('not every step is done or skipped');
    for (const s of stepsOf(task)) {
      if (s.status === 'skipped' && !s.skip_reason) missing.push(`${s.id}: skipped without a reason`);
    }
    return missing;
  },
  REVIEWING() { return []; },
  DOCUMENTING() { return []; },
  LANDING(ctx, task) {
    const missing = [];
    if (!allStepsClosed(task)) missing.push('not every step is done or skipped');
    const acs = readSpecMeta(task)?.acceptance_criteria ?? [];
    for (const ac of acs) {
      if (!ac.verified_by) missing.push(`${ac.id}: no verification evidence recorded`);
    }
    return missing;
  },
  DONE(ctx, task) {
    const missing = [];
    const final = artifactText(task, 'final.md');
    if (!final || final.trim().length < 20) missing.push('final.md is missing — run `timc final --render`');
    const facts = G.worktree(ctx.codeRoot);
    const committed = G.commitsWithTrailer(ctx.codeRoot, 'TIMC-Task', task.id);
    if (facts.dirty) missing.push(`the code worktree still has ${facts.files.length} uncommitted change(s)`);
    if (!committed.length && task.track !== 'trivial') {
      missing.push(`no commit carries the trailer "TIMC-Task: ${task.id}"`);
    }
    return missing;
  },
};

/** @returns {{ok: boolean, to: string|null, missing: string[]}} */
export function canAdvance(ctx, task) {
  const to = nextPhase(task);
  if (!to) return { ok: false, to: null, missing: ['the task is already in its final phase'] };
  const guard = GUARDS[to];
  const missing = guard ? guard(ctx, task) : [];
  return { ok: missing.length === 0, to, missing };
}

/**
 * The single source of truth for "what should happen now".
 * @returns {{action: string, title: string, why: string, command: string|null, missing?: string[], step?: string|null, phase?: string|null}}
 */
export function next(ctx) {
  const { task } = ctx;
  if (!task) {
    return {
      action: 'create_task',
      title: 'No active task',
      why: 'nothing is being worked on',
      command: 'timc new "<what you want to build>"',
    };
  }
  if (task.suspend) {
    const kind = task.suspend.kind;
    const cmd = {
      AWAITING_USER: `timc answer <ID> "<answer>"`,
      BLOCKED: 'timc unblock',
      PAUSED: 'timc resume',
      PAUSED_LIMIT: 'timc resume',
      RECOVERY_REQUIRED: 'timc doctor',
      ABANDONED: null,
    }[kind] ?? 'timc resume';
    return {
      action: 'resolve_suspend',
      title: `Suspended: ${kind}`,
      why: task.suspend.reason ?? 'no reason recorded',
      command: cmd,
      phase: task.phase,
    };
  }
  if (task.phase === 'DONE') {
    return { action: 'none', title: 'Task complete', why: `${task.id} is DONE`, command: 'timc new "<next task>"' };
  }

  if (task.phase === 'BUILDING') {
    if (!stepsOf(task).length) {
      return {
        action: 'plan_steps',
        title: 'No steps yet',
        why: 'implementation cannot start without at least one bounded step',
        command: 'timc step add --goal "<goal>" --touches "<glob>" --validate "<command>"',
        phase: task.phase,
      };
    }
    const step = actionableStep(task);
    if (step) {
      if (step.status === 'in_progress' || step.status === 'validating') {
        const v = verifyStep(ctx.P, task, step);
        if (v.ok) {
          return {
            action: 'complete_step',
            title: `${step.id} is validated`,
            why: `${v.satisfied.length} validation command(s) passed with recorded evidence`,
            command: `timc step complete ${step.id}`,
            step: step.id,
            phase: task.phase,
          };
        }
        return {
          action: 'validate_step',
          title: `${step.id} needs validation`,
          why: v.missing.map((m) => `${m.command}: ${m.why}`).join(' · '),
          command: `timc run -- ${step.validate?.[0] ?? '<validation command>'}`,
          missing: v.missing.map((m) => m.command),
          step: step.id,
          phase: task.phase,
        };
      }
      if (step.status === 'needs_fix') {
        return {
          action: 'fix_step',
          title: `${step.id} needs a fix`,
          why: step.fail_reason ?? 'validation failed earlier',
          command: `timc step start ${step.id}`,
          step: step.id,
          phase: task.phase,
        };
      }
      return {
        action: 'start_step',
        title: `Start ${step.id}`,
        why: step.goal ?? '',
        command: `timc step start ${step.id}`,
        step: step.id,
        phase: task.phase,
      };
    }
    const blocked = stepsOf(task).filter((s) => !CLOSED_STEP.has(s.status));
    if (blocked.length) {
      return {
        action: 'unblock_steps',
        title: 'Every remaining step is blocked',
        why: blocked.map((s) => `${s.id} (${s.status})`).join(', '),
        command: 'timc status -v',
        phase: task.phase,
      };
    }
  }

  const adv = canAdvance(ctx, task);
  if (adv.ok) {
    return {
      action: 'advance_phase',
      title: `Advance to ${adv.to}`,
      why: 'every gate for the next phase is satisfied',
      command: 'timc phase advance',
      phase: adv.to,
    };
  }
  return {
    action: 'satisfy_gate',
    title: `Gate for ${adv.to ?? 'next phase'} is not satisfied`,
    why: adv.missing.join(' · '),
    command: gateCommand(adv.to, task),
    missing: adv.missing,
    phase: task.phase,
  };
}

function gateCommand(to, task) {
  switch (to) {
    case 'SPECIFYING': return '/timc interview';
    case 'ARCH_REVIEW': return '/timc review --arch';
    case 'PLANNING': return '/timc spec';
    case 'READY': return '/timc plan';
    case 'BUILDING': return '/timc implement';
    case 'VERIFYING': return `timc step start ${actionableStep(task)?.id ?? '<step>'}`;
    case 'LANDING': return '/timc verify';
    case 'DONE': return 'timc final --render';
    default: return 'timc status -v';
  }
}

/** @param {any} task */
export function progress(task) {
  const steps = stepsOf(task);
  if (!steps.length) return { done: 0, total: 0, pct: 0 };
  const done = steps.filter((s) => CLOSED_STEP.has(s.status)).length;
  return { done, total: steps.length, pct: Math.round((done / steps.length) * 100) };
}

/** True when `file` (repo-relative, posix) is inside any of the step's globs. */
export function matchesTouches(step, file) {
  const globs = Array.isArray(step?.touches) ? step.touches : [];
  return globs.some((g) => globToRegExp(g).test(file));
}

/** Minimal glob support: `**`, `*`, `?`. Enough for path ownership. */
export function globToRegExp(glob) {
  let re = '';
  const g = String(glob).replace(/\\/g, '/');
  for (let i = 0; i < g.length; i += 1) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i += 1; if (g[i + 1] === '/') i += 1; } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  if (!/[*?]$/.test(g) && fsIsDirLike(g)) re += '(/.*)?';
  return new RegExp(`^${re}$`);
}

function fsIsDirLike(g) {
  return g.endsWith('/') || !path.extname(g);
}

export function isTimcRuntimePath(codeRoot, timcDir, target) {
  const abs = path.resolve(codeRoot, target);
  const runtime = path.resolve(timcDir, 'runtime');
  const rel = path.relative(runtime, abs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function fileExistsNonEmpty(file) {
  try { return fs.statSync(file).size > 0; } catch { return false; }
}
