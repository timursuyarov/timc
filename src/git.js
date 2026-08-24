import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from './io.js';

/**
 * Run git and return trimmed stdout. Throws on non-zero exit.
 * @param {string} cwd @param {string[]} args
 */
export function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).replace(/\s+$/, '');
}

/** Same, but returns `fallback` instead of throwing. */
export function gitSafe(cwd, args, fallback = null) {
  try { return git(cwd, args); } catch { return fallback; }
}

export function isRepo(cwd) {
  return gitSafe(cwd, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

export function head(cwd) {
  return gitSafe(cwd, ['rev-parse', 'HEAD']);
}

export function shortHead(cwd) {
  return gitSafe(cwd, ['rev-parse', '--short', 'HEAD']);
}

export function branch(cwd) {
  return gitSafe(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

/** Porcelain status of tracked+untracked changes, excluding ignored files. */
export function porcelain(cwd) {
  return gitSafe(cwd, ['status', '--porcelain=v1', '--untracked-files=normal'], '') ?? '';
}

/** @returns {{dirty: boolean, files: string[], digest: string|null}} */
export function worktree(cwd) {
  const raw = porcelain(cwd);
  const files = raw.split('\n').map((l) => l.slice(3).trim()).filter(Boolean);
  return { dirty: raw.trim().length > 0, files, digest: raw.trim() ? sha256(raw) : null };
}

/**
 * Snapshot the dirty worktree as a real commit object WITHOUT touching the
 * working tree or any branch. Returns null when there is nothing to stash.
 */
export function stashCreate(cwd) {
  const out = gitSafe(cwd, ['stash', 'create']);
  return out && /^[0-9a-f]{7,40}$/.test(out) ? out : null;
}

export function updateRef(cwd, ref, sha) {
  return gitSafe(cwd, ['update-ref', ref, sha]) !== null;
}

export function listRefs(cwd, prefix) {
  const out = gitSafe(cwd, ['for-each-ref', '--format=%(refname) %(objectname)', prefix], '') ?? '';
  return out.split('\n').filter(Boolean).map((l) => {
    const [ref, obj] = l.split(' ');
    return { ref, sha: obj };
  });
}

export function absoluteGitDir(cwd) {
  return gitSafe(cwd, ['rev-parse', '--absolute-git-dir']);
}

/**
 * Exclude a path from the *code* repo locally, without touching the shared
 * .gitignore (decision D-2: .timc must not enter the code repo's history).
 * @returns {'added'|'present'|'failed'}
 */
export function ensureLocalExclude(codeRoot, line) {
  const gitDir = absoluteGitDir(codeRoot);
  if (!gitDir) return 'failed';
  const file = path.join(gitDir, 'info', 'exclude');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (current.split('\n').some((l) => l.trim() === line)) return 'present';
    const sep = current.length && !current.endsWith('\n') ? '\n' : '';
    fs.appendFileSync(file, `${sep}# TIMC: process state lives in its own repository\n${line}\n`, 'utf8');
    return 'added';
  } catch { return 'failed'; }
}

export function initRepo(dir) {
  if (isRepo(dir) && path.resolve(gitSafe(dir, ['rev-parse', '--show-toplevel']) ?? '') === path.resolve(dir)) {
    return false;
  }
  git(dir, ['init', '--quiet']);
  gitSafe(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  return true;
}

/**
 * Commit everything in `dir`. Returns the new SHA, or null when there was
 * nothing to commit or git refused (missing identity, hooks, signing).
 * Never throws: losing a bookkeeping commit must not break the pipeline.
 */
export function commitAll(dir, message) {
  if (!isRepo(dir)) return null;
  if (gitSafe(dir, ['add', '-A']) === null) return null;
  const staged = gitSafe(dir, ['diff', '--cached', '--name-only'], '') ?? '';
  if (!staged.trim()) return null;
  const ok = gitSafe(dir, [
    '-c', 'commit.gpgsign=false',
    '-c', 'user.name=TIMC',
    '-c', 'user.email=timc@localhost',
    'commit', '--no-verify', '--quiet', '-m', message,
  ]);
  if (ok === null) return null;
  return head(dir);
}

export function isClean(dir) {
  return porcelain(dir).trim().length === 0;
}

/** Commits in the code repo carrying a given TIMC trailer. */
export function commitsWithTrailer(cwd, key, value) {
  const out = gitSafe(cwd, ['log', '--format=%H', '--fixed-strings', `--grep=${key}: ${value}`], '') ?? '';
  return out.split('\n').filter(Boolean);
}

export function checkoutNewBranch(cwd, name) {
  return gitSafe(cwd, ['checkout', '-q', '-b', name]) !== null;
}

export function branchExists(cwd, name) {
  return gitSafe(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]) !== null;
}
