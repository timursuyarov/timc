import path from 'node:path';
import { readStdinJson } from '../cli.js';
import { actionableStep, isTimcRuntimePath, matchesTouches } from '../machine.js';
import { appendEvent } from '../store.js';
import { relPosix } from '../paths.js';
import { readYaml } from '../io.js';

/**
 * PreToolUse hook. Two jobs:
 *  - deny writes that would let the model forge its own state or evidence;
 *  - keep the orchestrator out of production code on non-trivial tracks
 *    (invariant 5). The harness tells us who is asking: `agent_id` is present
 *    only inside a subagent, so the main session is identifiable without
 *    trusting anything the model says.
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
  process.stdout.write(`${JSON.stringify({ additionalContext: message })}\n`);
  return 0;
}

function guardWrite({ ctx, payload }) {
  const target = payload.tool_input?.file_path ?? payload.tool_input?.path ?? payload.tool_input?.notebook_path;
  if (!target) return 0;
  const abs = path.resolve(payload.cwd ?? ctx.codeRoot, String(target));

  if (isTimcRuntimePath(ctx.codeRoot, ctx.timcDir, abs)) {
    return deny(
      'TIMC: .timc/runtime/** is written by the harness only. Evidence and state you write '
      + 'yourself would prove nothing. Use the timc CLI (timc run, timc step complete).',
    );
  }

  const taskFileTouched = /[\\/]task\.yaml$/.test(abs);
  if (taskFileTouched) {
    return deny('TIMC: task.yaml is owned by the CLI. Use `timc step ...` / `timc phase ...` instead of editing it.');
  }

  const task = ctx.task;
  if (!task) return 0;

  const insideTimc = !path.relative(ctx.timcDir, abs).startsWith('..');
  if (!insideTimc && task.phase === 'BUILDING' && task.track !== 'trivial' && !payload.agent_id) {
    const allowed = (readYaml(ctx.P.permissions, {})?.orchestrator_may_write_code) ?? ['trivial'];
    if (!allowed.includes(task.track)) {
      return deny(
        `TIMC: the orchestrator session does not write production code on the ${task.track} track. `
        + 'Delegate this step to an implementor subagent (it gets its own context window), '
        + 'or run `timc step ...` to record what changes. Invariant 5.',
      );
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
      return inform(
        `TIMC scope drift: ${rel} is outside ${step.id}'s touches[] (${(step.touches ?? []).join(', ')}). `
        + 'If this file really belongs to the step, update the plan; otherwise create a follow-up task. '
        + 'The edit was recorded as drift.',
      );
    }
  }
  return 0;
}

function guardBash({ ctx, payload }) {
  const command = String(payload.tool_input?.command ?? '');
  if (!command) return 0;
  const rules = readYaml(ctx.P.permissions, {})?.dangerous_ops ?? [];
  const hit = rules.find((r) => r?.match && command.toLowerCase().includes(String(r.match).toLowerCase()));
  if (!hit) return 0;
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

export default guard;
