import path from 'node:path';
import { ensureDir, slugify, writeAtomic, writeYaml } from '../io.js';
import { appendEvent, commitState, listTasks, loadTask, nextTaskId } from '../store.js';
import { classify, TRACKS } from '../classify.js';
import * as T from '../templates.js';
import * as G from '../git.js';
import { c } from '../render.js';
import { next as computeNext } from '../machine.js';

/**
 * `timc new "<title>" [--intent "..."] [--track standard] [--no-branch]`
 * Creates the task, classifies its track deterministically, stamps artifacts.
 */
export async function newTask({ args, ctx }) {
  const title = args.positional.join(' ').trim() || String(args.flags.title ?? '').trim();
  if (!title) {
    process.stderr.write('timc new: give the task a title, e.g. timc new "add partial refunds"\n');
    return 1;
  }
  const intent = args.flags.intent ? String(args.flags.intent) : title;
  const auto = classify(`${title} ${intent}`);
  let track = auto.track;
  if (args.flags.track) {
    const wanted = String(args.flags.track);
    if (!TRACKS.includes(wanted)) {
      process.stderr.write(`timc new: unknown track "${wanted}" (${TRACKS.join(' | ')})\n`);
      return 1;
    }
    track = wanted;
  }

  const id = nextTaskId(ctx.P);
  const slug = slugify(title);
  const dir = path.join(ctx.P.tasks, `${id}-${slug}`);
  ensureDir(dir);

  // D-4: trivial tasks stay on the current branch; others get their own.
  const wantBranch = track !== 'trivial' && args.flags.branch !== false && args.flags['no-branch'] !== true;
  const branchName = `timc/${id}-${slug}`;
  let branch = G.branch(ctx.codeRoot);
  let branchNote = 'joriy branch / current branch';
  if (wantBranch) {
    if (!G.isClean(ctx.codeRoot)) {
      branchNote = c.yellow('worktree dirty — branch not created; commit or stash first');
    } else if (G.branchExists(ctx.codeRoot, branchName)) {
      branchNote = 'branch already existed';
      branch = branchName;
    } else if (G.checkoutNewBranch(ctx.codeRoot, branchName)) {
      branch = branchName;
      branchNote = 'yangi branch / new branch';
    } else {
      branchNote = c.yellow('could not create branch');
    }
  }

  const doc = T.taskDoc({
    id,
    title,
    intent,
    track,
    classification: { score: auto.score, signals: auto.signals, auto_track: auto.track },
    branch,
  });
  writeYaml(path.join(dir, 'task.yaml'), doc);

  const stub = { id, title };
  if (track !== 'trivial') {
    writeAtomic(path.join(dir, 'interview.md'), T.interviewMd(stub));
    writeAtomic(path.join(dir, 'spec.md'), T.specMd(stub));
    writeAtomic(path.join(dir, 'plan.md'), T.planMd(stub));
  }
  writeAtomic(path.join(dir, 'decisions.md'), T.DECISIONS_MD);
  writeAtomic(path.join(dir, 'risks.md'), T.RISKS_MD);
  writeAtomic(path.join(dir, 'implementation-log.md'), T.implementationLogMd(stub));
  writeAtomic(path.join(dir, 'validation.md'), T.validationMd(stub));

  const task = loadTask(ctx.P, id);
  ctx.task = task;
  ctx.state.activeTask = id;
  ctx.state.phase = task.phase;
  ctx.state.currentStep = null;
  ctx.state.lastCompletedStep = null;

  appendEvent(ctx.P, { type: 'TASK_CREATED', task: id, actor: 'human', payload: { title, track, score: auto.score, signals: auto.signals, branch } });
  if (track !== auto.track) {
    appendEvent(ctx.P, { type: 'TRACK_ASSIGNED', task: id, actor: 'human', payload: { from: auto.track, to: track, by: 'user' } });
  }
  commitState(ctx, `timc: ${id} created (${track})`);
  updateIndex(ctx);

  const hint = computeNext(ctx);
  if (args.flags.json) {
    process.stdout.write(`${JSON.stringify({ id, dir, track, classification: doc.classification, branch, next: hint }, null, 2)}\n`);
    return 0;
  }
  const L = [];
  L.push(`${c.bold('TIMC')} · ${c.bold(id)} yaratildi / created`);
  L.push(`  ${title}`);
  L.push(`  track: ${c.bold(track)} ${c.dim(`(score ${auto.score}${auto.signals.length ? `: ${auto.signals.join(', ')}` : ''})`)}${track !== auto.track ? c.yellow(` — overridden from ${auto.track}`) : ''}`);
  L.push(`  branch: ${branch} ${c.dim(`(${branchNote})`)}`);
  L.push(`  files: ${path.relative(ctx.codeRoot, dir).split(path.sep).join('/')}/`);
  L.push('');
  L.push(`${c.bold('Keyingi / next:')} ${hint.title}`);
  if (hint.command) L.push(`  ${c.cyan(hint.command)}`);
  process.stdout.write(`${L.join('\n')}\n`);
  return 0;
}

/** Regenerate tasks/INDEX.md so the task list is browsable without the CLI. */
export function updateIndex(ctx) {
  const rows = listTasks(ctx.P)
    .map((t) => `| ${t.id} | ${t.title} | ${t.track} | ${t.phase}${t.suspend ? ` (${t.suspend.kind})` : ''} | ${t.updated ?? ''} |`)
    .join('\n');
  writeAtomic(ctx.P.tasksIndex, `# Tasks\n\n| id | title | track | phase | updated |\n|---|---|---|---|---|\n${rows}\n`);
}

export { newTask as new };
export default newTask;
