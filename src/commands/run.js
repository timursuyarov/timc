import { spawnSync } from 'node:child_process';
import { recordEvidence } from '../evidence.js';
import { appendEvent, gitFacts } from '../store.js';
import { actionableStep } from '../machine.js';
import { nowIso } from '../io.js';
import { c } from '../render.js';

/**
 * `timc run -- <command>` — the reliable evidence path.
 * The real exit code is recorded and mirrored back, so a failing build cannot
 * be reported as a success.
 */
export async function run({ args, ctx }) {
  const command = args.rest.join(' ').trim() || String(args.flags.cmd ?? '').trim();
  if (!command) {
    process.stderr.write('timc run: give a command, e.g. timc run -- dotnet build\n');
    return 1;
  }
  const step = args.flags.step
    ? String(args.flags.step)
    : (ctx.task ? actionableStep(ctx.task)?.id ?? null : null);
  const cwd = args.flags.cwd ? String(args.flags.cwd) : ctx.codeRoot;

  const startedAt = nowIso();
  const t0 = Date.now();
  const res = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  const durationMs = Date.now() - t0;
  const stdout = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const exit = res.status === null ? 130 : res.status;

  if (!args.flags.quiet && stdout) process.stdout.write(stdout.endsWith('\n') ? stdout : `${stdout}\n`);

  const rec = recordEvidence(ctx.P, {
    task: ctx.task?.id ?? null,
    step,
    command,
    cwd,
    source: 'wrapper:timc run',
    exit,
    startedAt,
    durationMs,
    stdout,
    git: gitFacts(ctx.codeRoot),
  });
  appendEvent(ctx.P, {
    type: 'EVIDENCE_RECORDED',
    task: ctx.task?.id ?? null,
    step,
    payload: { id: rec.id, command, exit, durationMs },
  });

  const mark = exit === 0 ? c.green('✓') : c.red('×');
  process.stdout.write(`${mark} exit ${exit} · ${(durationMs / 1000).toFixed(1)}s · evidence ${rec.id}${step ? ` → ${step}` : c.dim(' (no step attached)')}\n`);
  return exit;
}

export default run;
