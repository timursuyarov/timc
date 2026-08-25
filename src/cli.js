#!/usr/bin/env node
import { findRoots, paths } from './paths.js';
import { loadCtx } from './store.js';
import { withLock } from './io.js';

/** Exit codes: 0 ok · 1 error · 2 gate/guard rejection · 3 lock busy. */
export const EXIT = { OK: 0, ERROR: 1, REJECTED: 2, LOCKED: 3 };

const COMMANDS = {
  init: () => import('./commands/init.js'),
  new: () => import('./commands/new.js'),
  status: () => import('./commands/status.js'),
  next: () => import('./commands/status.js'),
  brief: () => import('./commands/brief.js'),
  step: () => import('./commands/step.js'),
  phase: () => import('./commands/phase.js'),
  run: () => import('./commands/run.js'),
  record: () => import('./commands/record.js'),
  guard: () => import('./commands/guard.js'),
  checkpoint: () => import('./commands/checkpoint.js'),
  resume: () => import('./commands/resume.js'),
  doctor: () => import('./commands/doctor.js'),
  drift: () => import('./commands/drift.js'),
  frontier: () => import('./commands/frontier.js'),
  questions: () => import('./commands/frontier.js'),
  decide: () => import('./commands/decide.js'),
  final: () => import('./commands/final.js'),
  suspend: () => import('./commands/suspend.js'),
  ask: () => import('./commands/suspend.js'),
  answer: () => import('./commands/suspend.js'),
  block: () => import('./commands/suspend.js'),
  unblock: () => import('./commands/suspend.js'),
  pause: () => import('./commands/suspend.js'),
  abandon: () => import('./commands/suspend.js'),
  selftest: () => import('./commands/selftest.js'),
};

/** Commands that change state and therefore need the lock. */
// `run` and `record` only append to the evidence log, so they stay lock-free:
// a hook must never lose evidence because another session holds the lock.
const MUTATING = new Set([
  'init', 'new', 'step', 'phase', 'checkpoint', 'resume', 'decide', 'final',
  'doctor', 'suspend', 'ask', 'answer', 'block', 'unblock', 'pause', 'abandon',
]);

const HELP = `timc — durable engineering pipeline (V0)

  timc init                      Set up .timc/ (its own git repo) in this project
  timc new "<title>"             Create a task and classify its track
  timc status [-v] [--json]      Where the pipeline stands
  timc next [--json]             The single next allowed action
  timc brief [--budget N]        Deterministic context pack for the current phase
  timc phase advance|set <P>     Move phases (gates are enforced)
  timc frontier                  What is askable / workable right now
  timc step add|list|start|complete|fail|skip
  timc run -- <cmd>              Run a command and record evidence
  timc checkpoint [--auto]       Snapshot state + dirty worktree
  timc resume [--json]           Reconcile state with git and say what to do
  timc doctor [--rebuild]        Verify / rebuild runtime from durable truth
  timc decide "<q>" --decision "..." --reason "..." [--by user --evidence Q-001]
  timc final --render            Regenerate final.md from durable state
  timc drift                     Compare the diff against the plan's touches[]
  timc ask|answer|block|unblock|pause|abandon
  timc selftest                  Run the acceptance tests

Hook mode (used by hooks.json): --hook reads the event JSON on stdin.
`;

/** @param {string[]} argv */
export function parseArgs(argv) {
  const out = { cmd: null, positional: [], flags: {}, rest: [] };
  let i = 0;
  for (; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') { out.rest = argv.slice(i + 1); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const k = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let value;
      if (eq !== -1) value = a.slice(eq + 1);
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) { value = argv[i + 1]; i += 1; } else value = true;
      if (k.startsWith('no-') && value === true) out.flags[k.slice(3)] = false;
      else if (k in out.flags) {
        out.flags[k] = Array.isArray(out.flags[k]) ? [...out.flags[k], value] : [out.flags[k], value];
      } else out.flags[k] = value;
    } else if (a === '-v') out.flags.verbose = true;
    else if (a === '-h') out.flags.help = true;
    else if (out.cmd === null) out.cmd = a;
    else out.positional.push(a);
  }
  return out;
}

/** Read a hook payload from stdin without hanging when there is none. */
export async function readStdinJson(timeoutMs = 3000) {
  if (process.stdin.isTTY) return null;
  const raw = await new Promise((resolve) => {
    let data = '';
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => finish(data), timeoutMs);
    timer.unref?.();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => { data += d; });
    process.stdin.on('end', () => { clearTimeout(timer); finish(data); });
    process.stdin.on('error', () => { clearTimeout(timer); finish(''); });
  });
  if (!raw || !raw.trim()) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.cmd || args.flags.help || args.cmd === 'help') { process.stdout.write(HELP); return EXIT.OK; }
  if (args.cmd === '--version' || args.cmd === 'version') { process.stdout.write('timc 0.1.0\n'); return EXIT.OK; }

  const loader = COMMANDS[args.cmd];
  if (!loader) {
    process.stderr.write(`timc: unknown command "${args.cmd}"\n\n${HELP}`);
    return EXIT.ERROR;
  }
  const mod = await loader();
  const handler = mod[args.cmd] ?? mod.default;
  if (typeof handler !== 'function') {
    process.stderr.write(`timc: command "${args.cmd}" is not implemented yet\n`);
    return EXIT.ERROR;
  }

  const roots = findRoots(args.flags.cwd ? String(args.flags.cwd) : process.cwd());
  if (!roots.initialized && args.cmd !== 'init' && args.cmd !== 'selftest') {
    if (args.flags.hook) return EXIT.OK; // hooks stay silent in non-TIMC projects
    process.stderr.write('timc: this project has no .timc/ yet — run `timc init` first\n');
    return EXIT.ERROR;
  }

  const P = paths(roots.timcDir);
  const build = () => (roots.initialized
    ? loadCtx(roots, { taskId: args.flags.task ? String(args.flags.task) : null })
    : { codeRoot: roots.codeRoot, timcDir: roots.timcDir, P, state: null, task: null, config: {} });

  const invoke = () => handler({ args, roots, P, ctx: build() });

  try {
    const code = MUTATING.has(args.cmd) && roots.initialized && !args.flags.nolock
      ? await withLock(P.lock, invoke, { force: Boolean(args.flags.force) })
      : await invoke();
    return typeof code === 'number' ? code : EXIT.OK;
  } catch (err) {
    const e = /** @type {any} */ (err);
    if (args.flags.hook) return EXIT.OK; // never break the host session because TIMC failed
    if (e.code === 'ELOCKED') { process.stderr.write(`timc: ${e.message}\n`); return EXIT.LOCKED; }
    process.stderr.write(`timc: ${e.message}\n${process.env.TIMC_DEBUG ? `${e.stack}\n` : ''}`);
    return EXIT.ERROR;
  }
}

const isDirectRun = process.argv[1] && /cli\.js$/.test(process.argv[1].replace(/\\/g, '/'));
if (isDirectRun) {
  main().then((code) => process.exit(code));
}
