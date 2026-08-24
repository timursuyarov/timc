import path from 'node:path';
import { appendNdjson, ensureDir, nowIso, readNdjson, sha256, writeJson } from './io.js';

/**
 * Evidence is the only thing that can turn a step green (invariant 13).
 * It is written by the harness (PostToolUse hook) or by `timc run` — never by
 * the model, which is denied write access to .timc/runtime/**.
 */

/** Shell operators that can launder a non-zero exit code into a zero one. */
const LAUNDERING = /(\|\||&&|[|;&><])/;

/** @param {string} cmd */
export function normalizeCommand(cmd) {
  let c = String(cmd ?? '').replace(/\s+/g, ' ').trim();
  // Strip wrapping quotes a caller may have added.
  while ((c.startsWith('"') && c.endsWith('"')) || (c.startsWith("'") && c.endsWith("'"))) {
    c = c.slice(1, -1).trim();
  }
  // Strip leading directory changes: `cd foo && dotnet build` -> `dotnet build`.
  for (;;) {
    const m = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/i.exec(c);
    if (!m) break;
    c = c.slice(m[0].length).trim();
  }
  return c;
}

/**
 * Does a recorded command prove that `expected` actually ran on its own?
 * Prefix match only, and the remainder must not contain shell operators —
 * `echo "dotnet build"` and `dotnet build || true` are both rejected.
 * @param {string} expected @param {string} recorded
 * @returns {{ok: boolean, reason?: string}}
 */
export function commandProves(expected, recorded) {
  const want = normalizeCommand(expected);
  const got = normalizeCommand(recorded);
  if (!want) return { ok: false, reason: 'empty expected command' };
  if (got === want) return { ok: true };
  if (!got.startsWith(`${want} `)) return { ok: false, reason: 'recorded command is not the expected command' };
  const tail = got.slice(want.length);
  if (LAUNDERING.test(tail)) {
    return { ok: false, reason: `extra shell operators could hide the exit code: "${tail.trim()}"` };
  }
  return { ok: true };
}

/**
 * @param {ReturnType<import('./paths.js').paths>} P
 * @param {{task?: string|null, step?: string|null, command: string, cwd?: string,
 *          source: string, exit: number, startedAt?: string, durationMs?: number,
 *          stdout?: string, toolUseId?: string|null, git?: any}} rec
 */
export function recordEvidence(P, rec) {
  ensureDir(P.evidenceDir);
  const existing = readNdjson(P.evidenceLog);
  const stepKey = rec.step ?? 'NOSTEP';
  const n = existing.filter((e) => (e.step ?? 'NOSTEP') === stepKey).length + 1;
  const id = `${stepKey}-${n}`;
  const stdout = String(rec.stdout ?? '');
  const row = {
    schema: 'timc/evidence@1',
    id,
    task: rec.task ?? null,
    step: rec.step ?? null,
    command: String(rec.command ?? '').replace(/\s+/g, ' ').trim(),
    cwd: rec.cwd ?? null,
    source: rec.source,
    toolUseId: rec.toolUseId ?? null,
    startedAt: rec.startedAt ?? nowIso(),
    recordedAt: nowIso(),
    durationMs: rec.durationMs ?? null,
    exit: rec.exit,
    stdoutTail: stdout.slice(-2000),
    stdoutSha256: stdout ? sha256(stdout) : null,
    git: rec.git ?? null,
  };
  writeJson(path.join(P.evidenceDir, `${id}.json`), row);
  appendNdjson(P.evidenceLog, row);
  return row;
}

export function allEvidence(P) {
  return readNdjson(P.evidenceLog);
}

/**
 * Verify a step's declared validation commands against recorded evidence.
 * @returns {{ok: boolean, satisfied: any[], missing: {command: string, why: string}[]}}
 */
export function verifyStep(P, task, step) {
  const wanted = Array.isArray(step.validate) ? step.validate.filter(Boolean) : [];
  if (!wanted.length) {
    return {
      ok: false,
      satisfied: [],
      missing: [{ command: '(none declared)', why: 'the step declares no validate command — nothing can prove it works' }],
    };
  }
  const since = step.started ? Date.parse(step.started) : 0;
  const records = allEvidence(P).filter((e) => !e.task || !task?.id || e.task === task.id);
  const satisfied = [];
  const missing = [];

  for (const want of wanted) {
    const candidates = records.filter((e) => commandProves(want, e.command).ok);
    const fresh = candidates.filter((e) => Date.parse(e.startedAt ?? e.recordedAt ?? 0) >= since);
    const green = fresh.filter((e) => e.exit === 0);
    if (green.length) { satisfied.push(green[green.length - 1]); continue; }
    if (fresh.length) {
      const last = fresh[fresh.length - 1];
      missing.push({ command: want, why: `ran but failed (exit ${last.exit}, evidence ${last.id})` });
    } else if (candidates.length) {
      missing.push({ command: want, why: 'only evidence from before the step started' });
    } else {
      const near = records.filter((e) => normalizeCommand(e.command).includes(normalizeCommand(want)));
      const reason = near.length
        ? commandProves(want, near[near.length - 1].command).reason ?? 'no matching evidence'
        : 'no evidence recorded';
      missing.push({ command: want, why: reason });
    }
  }
  return { ok: missing.length === 0, satisfied, missing };
}
