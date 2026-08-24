import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import YAML from 'yaml';

export const LOCK_STALE_MS = 30 * 60 * 1000;

/** @param {string} dir */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Write via temp file + rename so a crash never leaves a half-written artifact. */
export function writeAtomic(file, contents) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, file);
}

export function readText(file, fallback = null) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}

export function readJson(file, fallback = null) {
  const raw = readText(file);
  if (raw === null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

export function writeJson(file, obj) {
  writeAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);
}

export function readYaml(file, fallback = null) {
  const raw = readText(file);
  if (raw === null) return fallback;
  return YAML.parse(raw);
}

export function writeYaml(file, obj) {
  writeAtomic(file, YAML.stringify(obj, { lineWidth: 0, nullStr: 'null' }));
}

export function appendNdjson(file, obj) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, 'utf8');
}

/** Tolerant reader: a truncated final line (crash mid-append) is skipped, not fatal. */
export function readNdjson(file) {
  const raw = readText(file, '');
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip damaged line */ }
  }
  return out;
}

export function sha256(text) {
  return `sha256:${crypto.createHash('sha256').update(text).digest('hex')}`;
}

export function slugify(text, max = 48) {
  const map = { ʻ: '', '‘': '', '’': '', "'": '', '`': '' };
  const cleaned = String(text).replace(/[ʻ‘’'`]/g, (c) => map[c] ?? '');
  return cleaned
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '') || 'task';
}

/** @returns {boolean} */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) {
    return /** @type {any} */ (e).code === 'EPERM';
  }
}

/**
 * Cooperative lock so two sessions can't interleave state mutations.
 * Stale locks (dead pid, or older than LOCK_STALE_MS) are taken over.
 */
export function acquireLock(lockFile, { force = false } = {}) {
  ensureDir(path.dirname(lockFile));
  const existing = readJson(lockFile);
  if (existing && !force) {
    const age = Date.now() - Date.parse(existing.ts ?? 0);
    const alive = Number.isInteger(existing.pid) && pidAlive(existing.pid);
    if (alive && age < LOCK_STALE_MS) {
      const err = new Error(
        `TIMC is locked by pid ${existing.pid} (since ${existing.ts}). ` +
        'Wait for it to finish, or re-run with --force if that process is gone.'
      );
      /** @type {any} */ (err).code = 'ELOCKED';
      throw err;
    }
  }
  writeJson(lockFile, { pid: process.pid, ts: nowIso(), host: os.hostname() });
  return () => { try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ } };
}

/** @template T @param {string} lockFile @param {() => T} fn @returns {T} */
export function withLock(lockFile, fn, opts = {}) {
  const release = acquireLock(lockFile, opts);
  try { return fn(); } finally { release(); }
}
