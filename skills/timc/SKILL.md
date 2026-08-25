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
6. **Never invent a user decision.** `timc decide ... --by user` requires
   `--evidence Q-00N` (an answered question) or `events#seq=N` (an
   `ANSWER_RECEIVED` event) and refuses anything else. Ask with `timc ask`.

## Interview: a design tree, worked in rounds

The interview is not a questionnaire. Model it as a **design tree**: every
decision branches into the decisions hanging off it. The **frontier** is every
decision whose prerequisites are already settled.

- Ask the **whole frontier in one round**, numbered, **each with your
  recommended answer**. Then stop and wait.
- **Facts are your job, never the user's.** If a question needs something the
  filesystem, git, or a tool can answer, go find it — dispatch a subagent if it
  is slow. Only *decisions* go to the user.
- A question whose answer depends on a question still open belongs to a **later
  round**. Declare that with `--depends`.
- The interview closes when the frontier is empty — not when it feels like enough.

```bash
timc ask "Can one payment have several partial refunds?" \
         --recommend "yes, capped at the captured amount" --risk high
timc ask "How is a partial refund split across accruals?" \
         --recommend "pro rata on the remaining balance" --depends Q-001
timc frontier                       # what is askable right now
timc answer Q-001 "yes, capped"     # recorded verbatim, linked to an event
```

`timc ask` refuses a question with no recommendation: an interview that hands the
thinking back to the user has not done its job.

## Spec: synthesis, and name the seams

Do **not** interview here — synthesize what the interview already settled.
Two things people skip and TIMC checks:

- **Seams.** Name where this gets tested, in `spec.md` front matter. Prefer an
  existing seam, use the highest one you can, and the fewer the better — one is
  ideal. A **new** seam needs the user's approval (`approved_by`).
- **No file paths, no code snippets.** They go stale in a week. The exception is
  a snippet that encodes a decision more precisely than prose can (state machine,
  schema, type shape) — trimmed to the decision.

## Plan: tracer bullets, not layers

Each step is a **tracer bullet**: a narrow but *complete* path through every
layer, demoable on its own, sized for one fresh context window.
`--delivers` is required and must describe end-to-end behaviour.

> "Domain model", "Repository layer", "API controller" are **horizontal** slices.
> Nothing validates them and nothing demos them — TIMC flags them.

Prefactor first: make the change easy, then make the easy change.

**Wide refactors are the exception.** One mechanical change whose blast radius
covers the codebase cannot land green as a slice. Sequence it and TIMC enforces
the ordering:

```bash
timc step add --kind expand   --goal "add new column beside the old"   ...
timc step add --kind migrate  --goal "move package A"  --depends R-001 ...
timc step add --kind migrate  --goal "move package B"  --depends R-001 ...
timc step add --kind contract --goal "delete the old column" --depends R-002,R-003
```

## Typical flow

```bash
timc new "add partial refunds"     # classifies the track deterministically
timc next                          # -> interview / spec / plan, per track
timc ask ... / timc answer ...     # rounds until the frontier is empty
timc phase advance                 # gate-checked
timc step add --goal "..." --delivers "..." --touches "src/**" --validate "dotnet test --filter Refund"
timc step start IMP-001
# ... implement (subagent on non-trivial tracks) ...
timc run -- dotnet test --filter Refund
timc step complete IMP-001
```

Trivial fix, minimum ceremony (stays on the current branch):

```bash
timc new "fix typo in reestr label" --track trivial
timc phase advance
timc step add --goal "fix label" --touches "src/**" --validate "npx tsc --noEmit"
timc step start IMP-001 && timc run -- npx tsc --noEmit && timc step complete IMP-001
```

## Decisions and the final record

Record a decision the moment it is made — not at the end, when the reasoning is
gone. `decisions.md` is **generated** from `task.yaml`; never edit it by hand.

```bash
timc decide "Can one payment have several partial refunds?" \
  --decision "yes, capped at the captured amount" \
  --reason "matches how the bank reports them" \
  --type BUSINESS --by user --evidence Q-001
```

At the end, `timc final --render` writes `final.md` from durable state: phases
(including any that were **bypassed**), steps and their evidence, decisions,
interview answers, acceptance criteria, seams, the commands that were actually
run, and the diff range. Only two sections are yours to write — *Differences
from the plan* and *Known limitations* — and re-rendering preserves them.

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

- `timc frontier` — askable questions and workable steps, right now
- `timc status -v` — engineering view (per-step evidence, revisions, signals)
- `timc drift` — changed files vs the plan's declared globs
- `timc checkpoint` — snapshot state + dirty worktree (no branch commit)
- `timc doctor --rebuild` — rebuild runtime state from durable truth
- `timc ask | answer | block | unblock | pause | abandon`
- `.timc/AGENTS.md` — the same contract, for any other agent

The interview, spec and slicing mechanics above are adapted from
[mattpocock/skills](https://github.com/mattpocock/skills) (`grilling`, `to-spec`,
`to-tickets`). TIMC's contribution is making them **checkable**: the frontier,
the seams, `delivers`, and the expand→migrate→contract ordering are data the
gates read, not advice the model may forget.
