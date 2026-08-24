import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson } from '../io.js';
import { appendEvent, commitState, gitFacts, lastSeq } from '../store.js';
import * as G from '../git.js';
import { c } from '../render.js';

/**
 * A checkpoint snapshots TIMC state *and* the dirty worktree — without adding a
 * commit to any branch. `git stash create` produces a commit object that is not
 * on a branch; `update-ref` under refs/timc/ protects it from gc. Nothing is
 * ever pushed, so the shared history stays clean (decision D-2).
 */
export function createCheckpoint(ctx, { reason = 'MANUAL', step = null, label = null } = {}) {
  const dir = ctx.P.checkpointsDir;
  fs.mkdirSync(dir, { recursive: true });
  const n = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length + 1;
  const id = `ckpt-${String(n).padStart(4, '0')}`;
  const facts = gitFacts(ctx.codeRoot);
  const mode = ctx.config?.workflow?.checkpoint?.mode ?? 'refs';

  let stashCommit = null;
  let ref = null;
  let patch = null;
  if (facts.dirty) {
    if (mode === 'patch') {
      const diff = G.gitSafe(ctx.codeRoot, ['diff', 'HEAD'], '') ?? '';
      if (diff) {
        patch = path.join(dir, `${id}.patch`);
        fs.writeFileSync(patch, diff, 'utf8');
      }
    } else {
      stashCommit = G.stashCreate(ctx.codeRoot);
      if (stashCommit) {
        ref = `refs/timc/checkpoints/${id}`;
        G.updateRef(ctx.codeRoot, ref, stashCommit);
      }
    }
  }

  const record = {
    schema: 'timc/checkpoint@1',
    id,
    at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    reason,
    label,
    task: ctx.task?.id ?? null,
    phase: ctx.task?.phase ?? null,
    step,
    eventSeq: lastSeq(ctx.P),
    stateSnapshot: readJson(ctx.P.state, null),
    taskRevision: ctx.task?.revision ?? null,
    git: {
      head: facts.head,
      branch: facts.branch,
      dirty: facts.dirty,
      dirtyDigest: facts.dirtyDigest,
      stashCommit,
      ref,
      patch: patch ? path.basename(patch) : null,
    },
    session: process.env.CLAUDE_SESSION_ID ?? null,
  };
  writeJson(path.join(dir, `${id}.json`), record);
  ctx.state.lastCheckpoint = id;
  appendEvent(ctx.P, {
    type: 'CHECKPOINT_CREATED',
    task: ctx.task?.id ?? null,
    step,
    payload: { id, reason, stashCommit, dirty: facts.dirty },
  });
  return record;
}

export async function checkpoint({ args, ctx }) {
  // The Stop / SessionEnd hooks call this on every turn; stay quiet when there
  // is nothing worth snapshotting.
  const auto = Boolean(args.flags.auto);
  const facts = gitFacts(ctx.codeRoot);
  const lastId = ctx.state?.lastCheckpoint;
  const last = lastId ? readJson(path.join(ctx.P.checkpointsDir, `${lastId}.json`), null) : null;
  const unchanged = last
    && last.git?.head === facts.head
    && last.git?.dirtyDigest === facts.dirtyDigest
    && last.eventSeq === lastSeq(ctx.P);

  if (auto && (unchanged || !ctx.task)) {
    if (args.flags.hook) return 0;
    process.stdout.write(`${c.dim('checkpoint: nothing changed since')} ${lastId ?? '—'}\n`);
    return 0;
  }

  const rec = createCheckpoint(ctx, {
    reason: args.flags.reason ? String(args.flags.reason) : (auto ? 'AUTO' : 'MANUAL'),
    step: ctx.state?.currentStep ?? null,
    label: args.flags.label ? String(args.flags.label) : null,
  });

  // An interrupted step must never look finished: mark it in state so the next
  // session's resume reports it as interrupted rather than idle.
  if (auto && ctx.state?.currentStep && facts.dirty) {
    ctx.state.interrupted = { step: ctx.state.currentStep, at: rec.at, checkpoint: rec.id };
  } else if (ctx.state) {
    delete ctx.state.interrupted;
  }
  commitState(ctx, `timc: checkpoint ${rec.id}`);

  if (args.flags.hook) return 0;
  if (args.flags.json) { process.stdout.write(`${JSON.stringify(rec, null, 2)}\n`); return 0; }
  process.stdout.write([
    `${c.green('✓')} ${rec.id} · ${rec.reason}`,
    `  git: ${rec.git.branch} @ ${(rec.git.head ?? '').slice(0, 8)}${rec.git.dirty ? ' (dirty)' : ' (clean)'}`,
    rec.git.stashCommit ? `  worktree snapshot: ${rec.git.stashCommit.slice(0, 8)} → ${rec.git.ref}` : '',
    rec.git.patch ? `  worktree patch: ${rec.git.patch}` : '',
  ].filter(Boolean).join('\n') + '\n');
  return 0;
}

export default checkpoint;
