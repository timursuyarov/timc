import path from 'node:path';
import { readStdinJson } from '../cli.js';
import { actionableStep, isTimcRuntimePath, matchesTouches } from '../machine.js';
import { appendEvent } from '../store.js';
import { relPosix } from '../paths.js';
import { readYaml } from '../io.js';
import { bashWriteTargets, canonicalCommand, timcInvocations } from '../shell.js';
import { JEV_KEY_VARS } from '../jev.js';

/**
 * PreToolUse hook. Three jobs:
 *  - deny writes that would let the model forge its own state, evidence or
 *    permissions — whether they come through Edit/Write or through Bash;
 *  - keep the orchestrator out of production code on non-trivial tracks
 *    (invariant 5). The harness tells us who is asking: `agent_id` is present
 *    only inside a subagent, so the main session is identifiable without
 *    trusting anything the model says;
 *  - deny destructive shell operations and attempts to impersonate the user.
 *
 * Everything is fail-open: if TIMC itself breaks, work continues.
 */
export async function guard({ args, ctx }) {
  const sub = args.positional[0] ?? 'write';
  const payload = args.flags.hook ? await readStdinJson() : parseManual(args);
  if (!payload) return 0;
  try {
    return sub === 'bash' ? guardBash({ ctx, payload }) : guardWrite({ ctx, payload });
  } catch {
    return 0;
  }
}

function parseManual(args) {
  if (args.flags.file) return { tool_name: 'Write', tool_input: { file_path: String(args.flags.file) }, agent_id: args.flags.agent ? String(args.flags.agent) : undefined };
  if (args.flags.command) return { tool_name: 'Bash', tool_input: { command: String(args.flags.command) } };
  return null;
}

function deny(reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })}\n`);
  return 0;
}

function inform(message) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: message },
  })}\n`);
  return 0;
}

/** The variable that tells TIMC a command came from Claude Code rather than the user. */
const IDENTITY = /CLAUDECODE/;

/**
 * Rules for one path the tool would write. Shared by the Write/Edit guard and
 * the Bash guard so the two can never disagree.
 * @returns {{deny: string} | {drift: string} | null}
 */
function writeVerdict(ctx, payload, abs, via) {
  if (isTimcRuntimePath(ctx.codeRoot, ctx.timcDir, abs)) {
    return {
      deny: `TIMC: .timc/runtime/** is written by the harness only${via}. Evidence and state you write `
        + 'yourself would prove nothing. Use the timc CLI (timc run, timc step complete).',
    };
  }
  if (/[\\/]task\.yaml$/.test(abs) && !path.relative(ctx.timcDir, abs).startsWith('..')) {
    return { deny: `TIMC: task.yaml is owned by the CLI${via}. Use \`timc step ...\` / \`timc phase ...\` instead of editing it.` };
  }
  const relTimc = path.relative(ctx.timcDir, abs).split(path.sep).join('/');
  if (relTimc === 'config' || relTimc.startsWith('config/')) {
    return {
      deny: `TIMC: .timc/config/** sets the rules you are held to (permissions, retry limits)${via}. `
        + 'Ask the user to change it themselves.',
    };
  }
  if (/^tasks\/[^/]+\/decisions\.md$/.test(relTimc)) {
    return { deny: `TIMC: decisions.md is generated from task.yaml${via}. Record decisions with \`timc decide\`.` };
  }

  const task = ctx.task;
  if (!task) return null;
  const insideTimc = !relTimc.startsWith('..');
  // Scratch files outside the repository (e.g. /tmp logs) are nobody's production code.
  const insideCode = !relPosix(ctx.codeRoot, abs).startsWith('..');
  if (!insideTimc && insideCode && task.phase === 'BUILDING' && task.track !== 'trivial' && !payload.agent_id) {
    const allowed = (readYaml(ctx.P.permissions, {})?.orchestrator_may_write_code) ?? ['trivial'];
    if (!allowed.includes(task.track)) {
      return {
        deny: `TIMC: the orchestrator session does not write production code on the ${task.track} track${via}. `
          + 'Delegate this step to an implementor subagent (it gets its own context window), '
          + 'or run `timc step ...` to record what changes. Invariant 5.',
      };
    }
  }

  const step = task.phase === 'BUILDING' ? actionableStep(task) : null;
  if (step && !insideTimc) {
    const rel = relPosix(ctx.codeRoot, abs);
    if (!rel.startsWith('..') && !matchesTouches(step, rel)) {
      try {
        appendEvent(ctx.P, {
          type: 'DRIFT_DETECTED',
          task: task.id,
          step: step.id,
          actor: payload.agent_id ? `agent:${payload.agent_type ?? 'unknown'}` : 'orchestrator',
          payload: { file: rel, touches: step.touches ?? [] },
        });
      } catch { /* recording drift must not block the edit */ }
      return {
        drift: `TIMC scope drift: ${rel} is outside ${step.id}'s touches[] (${(step.touches ?? []).join(', ')}). `
          + 'If this file really belongs to the step, update the plan; otherwise create a follow-up task. '
          + 'The edit was recorded as drift.',
      };
    }
  }
  return null;
}

function guardWrite({ ctx, payload }) {
  const input = payload.tool_input ?? {};
  const target = input.file_path ?? input.path ?? input.notebook_path;
  if (!target) return 0;
  const abs = path.resolve(payload.cwd ?? ctx.codeRoot, String(target));

  // A script that sheds CLAUDECODE would let the model run user-only commands as "the user".
  const body = [input.content, input.new_string, input.new_source, ...(input.edits ?? []).map((e) => e?.new_string)]
    .filter((x) => typeof x === 'string').join('\n');
  if (IDENTITY.test(body)) {
    return deny('TIMC: files that set or unset CLAUDECODE are not allowed — it is how TIMC tells your commands from the user\'s.');
  }

  const v = writeVerdict(ctx, payload, abs, '');
  if (v && 'deny' in v) return deny(v.deny);
  if (v && 'drift' in v) return inform(v.drift);
  return 0;
}

/** Subcommands only the user may trigger; everything else goes through --quote. */
const HARNESS_ONLY = new Set(['prompt']);

function guardBash({ ctx, payload }) {
  const command = String(payload.tool_input?.command ?? '');
  if (!command) return 0;

  if (IDENTITY.test(command)) {
    return deny('TIMC: commands that read, set or unset CLAUDECODE are not allowed — it is how TIMC tells your commands from the user\'s.');
  }
  // Unsetting the Jev key would turn a quote check off; printing it would leak it.
  const keyVar = JEV_KEY_VARS.find((v) => command.includes(v));
  if (keyVar) {
    return deny(`TIMC: commands that touch ${keyVar} are not allowed — it is the Jev credential TIMC's decision checks use.`);
  }
  for (const inv of timcInvocations(command)) {
    if (HARNESS_ONLY.has(inv.sub)) {
      return deny(`TIMC: \`timc ${inv.sub}\` is called by the UserPromptSubmit hook only — it records what the user typed.`);
    }
  }

  const rules = readYaml(ctx.P.permissions, {})?.dangerous_ops ?? [];
  const canon = canonicalCommand(command);
  const hit = rules.find((r) => r?.match && canon.includes(String(r.match).toLowerCase().replace(/\s+/g, ' ')));
  if (hit) {
    try {
      appendEvent(ctx.P, {
        type: 'DANGEROUS_OP_DENIED',
        task: ctx.task?.id ?? null,
        payload: { op: hit.id, command },
      });
    } catch { /* ignore */ }
    return deny(
      `TIMC: "${hit.id}" is a destructive operation and needs a human. Ask the user to run it themselves, `
      + 'or narrow the command. (Configured in .timc/config/permissions.yaml.)',
    );
  }

  let drift = null;
  for (const target of bashWriteTargets(command)) {
    const abs = path.resolve(payload.cwd ?? ctx.codeRoot, target);
    const v = writeVerdict(ctx, payload, abs, ' (also through Bash)');
    if (v && 'deny' in v) return deny(v.deny);
    if (v && 'drift' in v && !drift) drift = v.drift;
  }
  return drift ? inform(drift) : 0;
}

export default guard;
