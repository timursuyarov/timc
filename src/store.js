import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';
import {
  appendNdjson, ensureDir, nowIso, readJson, readNdjson, readYaml, writeJson, writeYaml,
} from './io.js';
import * as G from './git.js';

export const STATE_SCHEMA = 'timc/state@1';
export const TASK_SCHEMA = 'timc/task@1';

/**
 * @typedef {object} Ctx
 * @property {string} codeRoot
 * @property {string} timcDir
 * @property {ReturnType<typeof paths>} P
 * @property {any} state
 * @property {any|null} task
 * @property {any} config
 */

export function emptyState() {
  return {
    schema: STATE_SCHEMA,
    activeTask: null,
    phase: null,
    currentStep: null,
    lastCompletedStep: null,
    suspend: null,
    revision: 0,
    taskRevision: 0,
    lastEventSeq: 0,
    lastCheckpoint: null,
    git: null,
    session: null,
    rebuiltAt: null,
  };
}

export function loadState(P) {
  return readJson(P.state, emptyState()) ?? emptyState();
}

export function saveState(P, state) {
  state.schema = STATE_SCHEMA;
  state.revision = (state.revision ?? 0) + 1;
  writeJson(P.state, state);
  return state;
}

export function lastSeq(P) {
  const events = readNdjson(P.events);
  return events.length ? (events[events.length - 1].seq ?? events.length) : 0;
}

/**
 * Append one event. `seq` is assigned here and nowhere else.
 * @param {ReturnType<typeof paths>} P
 */
export function appendEvent(P, ev) {
  const seq = lastSeq(P) + 1;
  const row = {
    seq,
    ts: nowIso(),
    type: ev.type,
    task: ev.task ?? null,
    step: ev.step ?? null,
    actor: ev.actor ?? 'orchestrator',
    session: ev.session ?? process.env.CLAUDE_SESSION_ID ?? null,
    payload: ev.payload ?? {},
  };
  appendNdjson(P.events, row);
  return row;
}

export function readEvents(P) {
  return readNdjson(P.events);
}

/** Directory name for a task id, e.g. TASK-024 -> TASK-024-reestr-partial. */
export function taskDir(P, id) {
  if (!fs.existsSync(P.tasks)) return null;
  const match = fs.readdirSync(P.tasks).find((d) => d === id || d.startsWith(`${id}-`));
  return match ? path.join(P.tasks, match) : null;
}

export function taskFile(P, id) {
  const dir = taskDir(P, id);
  return dir ? path.join(dir, 'task.yaml') : null;
}

export function listTaskIds(P) {
  if (!fs.existsSync(P.tasks)) return [];
  const ids = new Set();
  for (const entry of fs.readdirSync(P.tasks)) {
    const m = /^(TASK-\d+)/.exec(entry);
    if (m) ids.add(m[1]);
  }
  return [...ids].sort();
}

export function nextTaskId(P) {
  const ids = listTaskIds(P).map((i) => Number.parseInt(i.slice(5), 10)).filter(Number.isFinite);
  const next = (ids.length ? Math.max(...ids) : 0) + 1;
  return `TASK-${String(next).padStart(3, '0')}`;
}

export function loadTask(P, id) {
  const file = taskFile(P, id);
  if (!file) return null;
  const task = readYaml(file);
  if (!task) return null;
  task.__file = file;
  task.__dir = path.dirname(file);
  return task;
}

export function saveTask(P, task) {
  const file = task.__file ?? taskFile(P, task.id);
  if (!file) throw new Error(`Task ${task.id} has no task.yaml on disk`);
  const clone = { ...task };
  delete clone.__file;
  delete clone.__dir;
  clone.schema = TASK_SCHEMA;
  clone.revision = (clone.revision ?? 0) + 1;
  clone.updated = nowIso();
  ensureDir(path.dirname(file));
  writeYaml(file, clone);
  clone.__file = file;
  clone.__dir = path.dirname(file);
  return clone;
}

export function listTasks(P) {
  return listTaskIds(P).map((id) => loadTask(P, id)).filter(Boolean);
}

/** Tasks that are neither DONE nor ABANDONED. */
export function openTasks(P) {
  return listTasks(P).filter((t) => t.phase !== 'DONE' && t.suspend?.kind !== 'ABANDONED');
}

export function loadConfig(P) {
  return {
    project: readYaml(P.project, {}) ?? {},
    workflow: readYaml(P.workflow, {}) ?? {},
    agents: readYaml(P.agents, {}) ?? {},
  };
}

/**
 * Build the read-only context every command starts from.
 * @param {{codeRoot: string, timcDir: string}} roots
 * @param {{taskId?: string|null}} [opts]
 * @returns {Ctx}
 */
export function loadCtx(roots, opts = {}) {
  const P = paths(roots.timcDir);
  const state = loadState(P);
  const wantId = opts.taskId ?? state.activeTask;
  let task = wantId ? loadTask(P, wantId) : null;
  if (!task) {
    const open = openTasks(P);
    task = open.length === 1 ? open[0] : null;
  }
  return { codeRoot: roots.codeRoot, timcDir: roots.timcDir, P, state, task, config: loadConfig(P) };
}

/** Current git facts about the *code* repo. */
export function gitFacts(codeRoot) {
  const wt = G.worktree(codeRoot);
  return {
    head: G.head(codeRoot),
    short: G.shortHead(codeRoot),
    branch: G.branch(codeRoot),
    dirty: wt.dirty,
    dirtyFiles: wt.files,
    dirtyDigest: wt.digest,
  };
}

/**
 * Persist state + auto-commit the .timc repo. Every mutating command ends here,
 * so process history is durable even if the session dies immediately after.
 */
export function commitState(ctx, message) {
  const facts = gitFacts(ctx.codeRoot);
  ctx.state.git = {
    head: facts.head, branch: facts.branch, dirty: facts.dirty, dirtyDigest: facts.dirtyDigest,
  };
  ctx.state.lastEventSeq = lastSeq(ctx.P);
  if (ctx.task) {
    ctx.state.activeTask = ctx.task.id;
    ctx.state.phase = ctx.task.phase;
    ctx.state.taskRevision = ctx.task.revision ?? 0;
    ctx.state.suspend = ctx.task.suspend ?? null;
  }
  saveState(ctx.P, ctx.state);
  const sha = G.commitAll(ctx.timcDir, `${message}${facts.short ? ` (code: ${facts.short})` : ''}`);
  return sha;
}
