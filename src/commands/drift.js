import { actionableStep, matchesTouches, stepsOf } from '../machine.js';
import { gitFacts } from '../store.js';
import { c } from '../render.js';

/**
 * `timc drift` — deterministic scope-drift check: the working tree's changed
 * files against the globs the plan declared. No model involved.
 */
export async function drift({ args, ctx }) {
  if (!ctx.task) { process.stderr.write('timc drift: no active task\n'); return 1; }
  const facts = gitFacts(ctx.codeRoot);
  const files = facts.dirtyFiles.filter((f) => !f.startsWith('.timc/'));
  const step = actionableStep(ctx.task);
  const steps = stepsOf(ctx.task);

  const rows = files.map((f) => {
    const owners = steps.filter((s) => matchesTouches(s, f)).map((s) => s.id);
    return { file: f, owners, inCurrentStep: step ? owners.includes(step.id) : false };
  });
  const unowned = rows.filter((r) => !r.owners.length);
  const otherStep = rows.filter((r) => r.owners.length && step && !r.inCurrentStep);

  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify({ step: step?.id ?? null, files: rows, unowned, otherStep }, null, 2)}\n`);
    return unowned.length ? 2 : 0;
  }
  const L = [c.bold('TIMC drift')];
  L.push(`joriy step / current step: ${step?.id ?? '—'}`);
  L.push(`o'zgargan fayllar / changed files: ${files.length}`);
  if (!files.length) { L.push(`  ${c.green('✓')} ishchi daraxt toza / worktree clean`); }
  for (const r of rows) {
    const mark = r.owners.length === 0 ? c.red('×') : r.inCurrentStep ? c.green('✓') : c.yellow('!');
    L.push(`  ${mark} ${r.file}${r.owners.length ? c.dim(`  → ${r.owners.join(', ')}`) : c.dim('  → no step claims this file')}`);
  }
  if (unowned.length) {
    L.push('');
    L.push(c.yellow(`SCOPE_DRIFT: ${unowned.length} fayl rejada e'lon qilinmagan / file(s) not declared in the plan`));
    L.push(c.dim('  Rejani yangilang (touches[]) yoki follow-up task yarating.'));
  }
  process.stdout.write(`${L.join('\n')}\n`);
  return unowned.length ? 2 : 0;
}

export default drift;
