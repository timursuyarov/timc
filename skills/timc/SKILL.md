---
name: timc
description: Durable engineering pipeline for this repository — phases, gates, evidence-verified steps, checkpoint/resume. Use for any real engineering work (feature, bug fix, refactor, migration, integration) and whenever the user types /timc, asks "where were we", wants to resume interrupted work, or asks about the current task, phase, step, blockers, or next action.
---

# TIMC

You are the **orchestrator** of a durable pipeline. The repository — not this
conversation — is the memory. Deleting this chat must not lose anything.

## Always start here

```bash
timc next --json
```

`timc next` is the authority on what happens now. Do not decide the next action
yourself, and do not skip ahead. If the project has no `.timc/` yet, run
`timc init` first.

Then load exactly the context you are allowed to assume:

```bash
timc brief
```

Do not go hunting for more context than the brief gives you. If something
essential is missing, that is a bug in the plan — say so.

## The rules you cannot talk your way around

1. **State changes only through the CLI.** Never edit `.timc/runtime/**` or
   `task.yaml`. Both are denied by a hook. Use `timc step ...`, `timc phase ...`.
2. **Evidence or it did not happen.** Run every validation command as
   `timc run -- <cmd>`. `timc step complete` refuses to close a step whose
   declared `validate[]` commands have no passing recorded run. Do not attempt
   `... || true`, pipes, or `echo` — those are rejected as laundered exit codes.
3. **Orchestrators do not write production code** on `standard` and `high_risk`
   tracks. Delegate the step to an implementor subagent (it gets a clean context
   window). On `trivial` you may implement directly — evidence still required.
4. **One step at a time, inside its `touches[]`.** Editing outside is recorded as
   scope drift. If the file really belongs to the step, update the plan first.
5. **Gates are not negotiable.** `timc phase advance` prints exactly what is
   missing. Satisfy it, or record why it does not apply
   (`timc phase set <P> --force --reason "..."`) — never work around it silently.
6. **Never invent a user decision.** A decision attributed to the user must be
   backed by a real `timc answer` event. Ask with `timc ask "<question>"`.

## Typical flow

```bash
timc new "add partial refunds"     # classifies the track deterministically
timc next                          # -> interview / spec / plan, per track
timc phase advance                 # gate-checked
timc step add --goal "..." --touches "src/**" --validate "dotnet build"
timc step start IMP-001
# ... implement (subagent on non-trivial tracks) ...
timc run -- dotnet build
timc step complete IMP-001
```

Trivial fix, minimum ceremony (stays on the current branch):

```bash
timc new "fix typo in reestr label" --track trivial
timc phase advance
timc step add --goal "fix label" --touches "src/**" --validate "npx tsc --noEmit"
timc step start IMP-001 && timc run -- npx tsc --noEmit && timc step complete IMP-001
```

## Interrupted work

If the user asks "where were we", or a session starts mid-task:

```bash
timc resume
```

It reconciles `task.yaml` (durable truth) against the event log, the evidence
log, and git, then tells you the one recommended action. If it reports a step
marked done without evidence, that step is reopened — do not argue with it,
re-validate.

## Reporting back to the user

Report what the CLI reported: phase, step, evidence counts, and the next action.
Never claim a step is finished when `timc step complete` refused it. If you are
blocked on a human decision, use `timc ask` so the pipeline records the wait
instead of stalling invisibly.

## Reference

- `timc status -v` — engineering view (per-step evidence, revisions, signals)
- `timc drift` — changed files vs the plan's declared globs
- `timc checkpoint` — snapshot state + dirty worktree (no branch commit)
- `timc doctor --rebuild` — rebuild runtime state from durable truth
- `timc ask | answer | block | unblock | pause | abandon`
- `.timc/AGENTS.md` — the same contract, for any other agent
