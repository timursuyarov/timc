import fs from 'node:fs';
import path from 'node:path';

export const TIMC_DIR_NAME = '.timc';
export const PROTOCOL_VERSION = '1';

/**
 * Walk up from `startDir` looking for an initialized .timc/ directory.
 * Falls back to the enclosing git repository root (for `timc init`).
 * @param {string} [startDir]
 */
export function findRoots(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  let gitRoot = null;
  for (;;) {
    const timc = path.join(dir, TIMC_DIR_NAME);
    if (isDir(timc)) return { codeRoot: dir, timcDir: timc, initialized: true };
    if (gitRoot === null && fs.existsSync(path.join(dir, '.git'))) gitRoot = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const codeRoot = gitRoot ?? path.resolve(startDir);
  return { codeRoot, timcDir: path.join(codeRoot, TIMC_DIR_NAME), initialized: false };
}

/**
 * All well-known paths inside .timc/. Nothing else in the codebase should
 * hand-build a path under .timc — add it here instead.
 * @param {string} timcDir
 */
export function paths(timcDir) {
  const runtime = path.join(timcDir, 'runtime');
  return {
    timcDir,
    version: path.join(timcDir, 'VERSION'),
    agentsMd: path.join(timcDir, 'AGENTS.md'),
    gitignore: path.join(timcDir, '.gitignore'),
    config: path.join(timcDir, 'config'),
    project: path.join(timcDir, 'config', 'project.yaml'),
    agents: path.join(timcDir, 'config', 'agents.yaml'),
    workflow: path.join(timcDir, 'config', 'workflow.yaml'),
    permissions: path.join(timcDir, 'config', 'permissions.yaml'),
    knowledge: path.join(timcDir, 'knowledge'),
    stack: path.join(timcDir, 'knowledge', 'stack.md'),
    dictionary: path.join(timcDir, 'knowledge', 'dictionary.md'),
    architecture: path.join(timcDir, 'architecture'),
    adr: path.join(timcDir, 'architecture', 'adr'),
    tasks: path.join(timcDir, 'tasks'),
    tasksIndex: path.join(timcDir, 'tasks', 'INDEX.md'),
    templates: path.join(timcDir, 'templates'),
    runtime,
    state: path.join(runtime, 'state.json'),
    events: path.join(runtime, 'events.ndjson'),
    evidenceLog: path.join(runtime, 'evidence.ndjson'),
    evidenceDir: path.join(runtime, 'evidence'),
    checkpointsDir: path.join(runtime, 'checkpoints'),
    briefsDir: path.join(runtime, 'briefs'),
    usage: path.join(runtime, 'usage.ndjson'),
    sessions: path.join(runtime, 'sessions.ndjson'),
    lock: path.join(runtime, '.lock'),
  };
}

/** @param {string} p */
export function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Repo-relative POSIX path — artifacts never store absolute or backslash paths. */
export function relPosix(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

/** @param {string} p */
export function toPosix(p) {
  return p.split(path.sep).join('/');
}
