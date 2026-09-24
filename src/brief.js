import fs from 'node:fs';
import path from 'node:path';
import { readText } from './io.js';
import { relPosix } from './paths.js';
import {
  actionableStep, artifact, globToRegExp, progress, readSpecMeta, stepsOf,
} from './machine.js';
import { readEvents } from './store.js';
import * as G from './git.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'obj', 'dist', 'build', '.vs', '.idea', 'coverage', '.next']);
const CHARS_PER_TOKEN = 4;

export const DEFAULT_BUDGET_TOKENS = 4000;
export const HARD_BUDGET_TOKENS = 8000;

const tokens = (text) => Math.ceil(text.length / CHARS_PER_TOKEN);

/** Static directory prefix of a glob, i.e. everything before the first wildcard. */
function globPrefix(glob) {
  const g = String(glob).replace(/\\/g, '/');
  const i = g.search(/[*?]/);
  const head = i === -1 ? g : g.slice(0, i);
  return head.endsWith('/') ? head.slice(0, -1) : path.posix.dirname(head) === '.' ? head : path.posix.dirname(head);
}

/**
 * Files matching the step's `touches` globs. Filesystem walk (not `git ls-files`)
 * so it works the same across submodules.
 */
export function listFilesForGlobs(codeRoot, globs, cap = 60) {
  const out = [];
  for (const glob of globs ?? []) {
    const re = globToRegExp(glob);
    const start = path.resolve(codeRoot, globPrefix(glob));
    const stack = [start];
    let depth = 0;
    while (stack.length && out.length < cap && depth < 20000) {
      depth += 1;
      const dir = stack.pop();
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (out.length >= cap) break;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) stack.push(abs);
          continue;
        }
        const rel = relPosix(codeRoot, abs);
        if (re.test(rel) && !out.includes(rel)) out.push(rel);
      }
    }
  }
  return out;
}

/**
 * Deterministic, budgeted context pack. Sections are dropped by priority when
 * the budget is exceeded, and what was dropped is always stated out loud.
 * @returns {{text: string, dropped: {name: string, tokens: number}[], tokens: number}}
 */
export function buildBrief(ctx, opts = {}) {
  const budget = Math.min(opts.budget ?? DEFAULT_BUDGET_TOKENS, HARD_BUDGET_TOKENS);
  const { task, P } = ctx;
  const sections = [];
  const add = (name, priority, body) => {
    if (body && body.trim()) sections.push({ name, priority, text: `${body.trim()}\n` });
  };

  if (!task) {
    return {
      text: [
        'TIMC BRIEF — no active task.',
        '',
        'Start with `timc status` then `timc new "<what you want to build>"`.',
        'Never write to .timc/runtime/** and never edit .timc state files by hand — use the timc CLI.',
      ].join('\n'),
      dropped: [],
      tokens: 40,
    };
  }

  const step = task.phase === 'BUILDING' ? actionableStep(task) : null;
  const prog = progress(task);
  const facts = G.worktree(ctx.codeRoot);

  add('STATE', 1, [
    `# TIMC BRIEF · ${task.id} · phase=${task.phase} · track=${task.track}` +
      `${step ? ` · step=${step.id}` : ''} · budget=${budget} tok`,
    '',
    `## [1] STATE`,
    `title: ${task.title}`,
    `intent: ${task.intent ?? '—'}`,
    `phase: ${task.phase}${task.suspend ? ` · SUSPENDED (${task.suspend.kind}: ${task.suspend.reason ?? ''})` : ''}`,
    `steps: ${prog.done}/${prog.total} closed (${prog.pct}%)`,
    recentEvents(P, task.id, 5),
  ].filter(Boolean).join('\n'));

  if (step) {
    add('STEP', 1, [
      '## [2] CURRENT STEP',
      `${step.id} — ${step.goal ?? ''}`,
      `owner: ${step.owner ?? 'implementor'} · risk: ${step.risk ?? 'unknown'} · status: ${step.status}`,
      `depends_on: ${(step.depends_on ?? []).join(', ') || '—'}`,
      `touches:\n${(step.touches ?? []).map((t) => `  - ${t}`).join('\n') || '  - (none declared)'}`,
      `validate:\n${(step.validate ?? []).map((t) => `  - timc run -- ${t}`).join('\n') || '  - (none declared)'}`,
      step.acceptance ? `acceptance: ${step.acceptance}` : null,
    ].filter(Boolean).join('\n'));
  }

  add('GUARDRAILS', 1, [
    '## [9] GUARDRAILS',
    '- Change state only through the `timc` CLI. Never edit .timc/runtime/** (writes there are denied).',
    '- Run every validation command through `timc run -- <cmd>` so evidence is recorded.',
    '- A step closes only when its declared validate commands have passing evidence.',
    step ? `- Stay inside this step's touches[]. Editing outside it is recorded as scope drift.` : null,
    task.track !== 'trivial'
      ? '- Implementation belongs to an implementor subagent, not the orchestrator session.'
      : '- Trivial track: the orchestrator may implement directly, but evidence is still required.',
  ].filter(Boolean).join('\n'));

  add('SPEC', 2, specSection(task, step));
  add('DECISIONS', 3, artifactSection(task, 'decisions.md', '[4] DECISIONS', 1600));
  add('DICTIONARY', 4, dictionarySection(ctx, step));
  add('GIT', 5, [
    '## [8] GIT (code repo)',
    `branch: ${facts.dirty ? `${G.branch(ctx.codeRoot)} (dirty)` : G.branch(ctx.codeRoot)} @ ${G.shortHead(ctx.codeRoot) ?? '—'}`,
    facts.files.length ? `changed:\n${facts.files.slice(0, 20).map((f) => `  - ${f}`).join('\n')}` : 'changed: (clean)',
  ].join('\n'));
  add('CODE', 6, codeSection(ctx, step));

  // Budget: keep priority 1 always, then add by priority until the budget is spent.
  const kept = [];
  const dropped = [];
  let used = 0;
  for (const s of [...sections].sort((a, b) => a.priority - b.priority)) {
    const t = tokens(s.text);
    if (s.priority === 1 || used + t <= budget) { kept.push(s); used += t; } else { dropped.push({ name: s.name, tokens: t }); }
  }
  kept.sort((a, b) => sections.indexOf(a) - sections.indexOf(b));

  let text = kept.map((s) => s.text).join('\n');
  if (dropped.length) {
    text += `\n--- DROPPED (budget ${budget} tok): ${dropped.map((d) => `${d.name} (~${d.tokens} tok)`).join(', ')}\n`;
  }
  text += `\nNext action: ${opts.nextHint ?? 'run `timc next`'}\n`;
  return { text, dropped, tokens: tokens(text) };
}

function recentEvents(P, taskId, n) {
  const evs = readEvents(P).filter((e) => !e.task || e.task === taskId).slice(-n);
  if (!evs.length) return null;
  return `recent:\n${evs.map((e) => `  - ${e.ts} ${e.type}${e.step ? ` ${e.step}` : ''}`).join('\n')}`;
}

function specSection(task, step) {
  const meta = readSpecMeta(task);
  if (!meta) return null;
  const acs = Array.isArray(meta.acceptance_criteria) ? meta.acceptance_criteria : [];
  const relevant = step?.acceptance ? acs.filter((a) => a.id === step.acceptance) : acs;
  const lines = ['## [3] SPEC (acceptance criteria)'];
  for (const ac of (relevant.length ? relevant : acs).slice(0, 8)) {
    lines.push(`- ${ac.id}: ${ac.text}${task.verifications?.[ac.id] ? ' [verified]' : ''}`);
  }
  const flags = ['schema_change', 'public_api_change', 'migration_required', 'security_relevant']
    .filter((k) => meta[k]);
  if (flags.length) lines.push(`flags: ${flags.join(', ')}`);
  return lines.length > 1 ? lines.join('\n') : null;
}

function artifactSection(task, name, heading, cap) {
  const p = artifact(task, name);
  const text = p ? readText(p, null) : null;
  if (!text || !text.trim()) return null;
  const body = text.length > cap ? `${text.slice(0, cap)}\n… (truncated, full text in ${name})` : text;
  return `## ${heading}\n${body}`;
}

function dictionarySection(ctx, step) {
  const text = readText(ctx.P.dictionary, null);
  if (!text) return null;
  const terms = [...text.matchAll(/^-\s*\*\*(.+?)\*\*\s*[—:-]\s*(.+)$/gm)].map((m) => ({ term: m[1], def: m[2] }));
  if (!terms.length) return null;
  const hay = `${step?.goal ?? ''} ${(step?.touches ?? []).join(' ')}`.toLowerCase();
  const picked = terms.filter((t) => hay.includes(t.term.toLowerCase())).slice(0, 12);
  const list = (picked.length ? picked : terms.slice(0, 12));
  return `## [5] DICTIONARY\n${list.map((t) => `- ${t.term}: ${t.def}`).join('\n')}`;
}

function codeSection(ctx, step) {
  if (!step?.touches?.length) return null;
  const files = listFilesForGlobs(ctx.codeRoot, step.touches, 60);
  if (!files.length) return `## [7] CODE\n(no existing files match this step's touches — new files expected)`;
  return `## [7] CODE (files in scope)\n${files.map((f) => `- ${f}`).join('\n')}`;
}
