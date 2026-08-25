import YAML from 'yaml';
import { nowIso } from './io.js';

export const AGENTS_MD = `# TIMC protocol contract

This file is generated. It tells **any** coding agent how to work in this
repository. It is host-agnostic on purpose: Claude Code, Codex, or anything else
that can run a shell command participates the same way.

## The one rule

Change process state **only** through the \`timc\` CLI. Never hand-edit
\`.timc/runtime/**\` and never hand-edit \`task.yaml\`. Writes to
\`.timc/runtime/**\` are denied by a hook, and a step cannot be closed without
machine-recorded evidence.

## Loop

1. \`timc next --json\` — the only authority on what happens now.
2. \`timc brief\` — the context you are allowed to assume. Do not go fishing for more.
3. Do the work for exactly one step, inside that step's \`touches[]\` globs.
4. Run every validation command as \`timc run -- <cmd>\` so evidence is recorded.
5. \`timc step complete <ID>\` — fails loudly if the evidence is not there.
6. Repeat.

## What earns a green status

Only evidence. A step closes when each command in its \`validate[]\` list has a
recorded run with exit 0, started after the step started. Saying "tests pass" is
not evidence; running them through \`timc run\` is. \`timc run -- dotnet build || true\`
is rejected — laundering an exit code is treated as no evidence at all.

## Phases and gates

\`timc phase advance\` refuses to move forward until the gate for the next phase
is satisfied, and prints exactly what is missing. Do not work around a gate;
either satisfy it or record why it does not apply.

## Decisions

Any decision a human made must be recorded with \`timc decide ... --by user\`,
which links it to the answer event. Never record a user decision the user did
not actually make.

## When context runs out

Compaction is normal. Everything durable is already on disk, so a fresh session
starts with \`timc brief\` and continues. Do not try to remember; read.
`;

export function projectYaml(detected, name) {
  return YAML.stringify({
    schema: 'timc/project@1',
    name,
    created: nowIso(),
    languages: detected.languages,
    repos: detected.repos,
    commands: detected.commands,
    external: { ticket: { provider: 'none' } },
    git: {
      branch_pattern: 'timc/{task}-{slug}',
      trailers: ['TIMC-Task', 'TIMC-Step', 'TIMC-Evidence', 'TIMC-Decisions'],
      conventional_commits: detected.conventionalCommits,
    },
    rules: detected.ruleFiles,
  }, { lineWidth: 0 });
}

export function workflowYaml() {
  return YAML.stringify({
    schema: 'timc/workflow@1',
    tracks: {
      trivial: { phases: ['CREATED', 'BUILDING', 'LANDING', 'DONE'], branch: 'current', interview: false, spec: false },
      standard: { branch: 'per_task' },
      high_risk: { branch: 'per_task', arch_review: true, security_review: true },
    },
    limits: { step_retries: 3, review_cycles: 2, brief_budget_tokens: 4000 },
    budgets: { task_usd: 15, day_usd: 60, warn_at: 0.8 },
    checkpoint: { mode: 'refs', keep_days: 30 },
  }, { lineWidth: 0 });
}

export function agentsYaml() {
  return YAML.stringify({
    schema: 'timc/agents@1',
    default_host: 'claude',
    roles: {
      orchestrator: { model: 'opus-5', effort: 'medium' },
      interviewer: { model: 'opus-5' },
      specifier: { model: 'opus-5' },
      planner: { model: 'opus-5', effort: 'high' },
      'implementor.backend': { model: 'sonnet-5', agentType: 'backend-implementer' },
      'implementor.frontend': { model: 'sonnet-5', agentType: 'frontend-implementer' },
      tester: { model: 'sonnet-5' },
      scribe: { model: 'haiku-4-5' },
    },
    fallback: { order: ['claude', 'codex'], on: ['rate_limit', 'overloaded', 'billing_error'] },
  }, { lineWidth: 0 });
}

export function permissionsYaml() {
  return YAML.stringify({
    schema: 'timc/permissions@1',
    deny_always: ['.timc/runtime/**'],
    dangerous_ops: [
      { id: 'db.drop', match: 'ef database drop' },
      { id: 'git.force_push', match: 'push --force' },
      { id: 'git.hard_reset', match: 'reset --hard' },
      { id: 'fs.recursive_delete', match: 'rm -rf' },
    ],
    orchestrator_may_write_code: ['trivial'],
  }, { lineWidth: 0 });
}

export function stackMd(detected) {
  const rows = Object.entries(detected.commands)
    .map(([k, v]) => `| ${k} | \`${v}\` | unverified |`)
    .join('\n');
  return `# Stack

Detected automatically by \`timc init\`. **A command marked \`unverified\` must not be
used as a step's \`validate\` entry** — run it once through \`timc run\` first, then
mark it verified here.

| purpose | command | status |
|---|---|---|
${rows || '| — | — | — |'}

## Repositories / modules

${detected.repos.map((r) => `- ${r}`).join('\n') || '- (single repo)'}

## Languages

${detected.languages.map((l) => `- ${l}`).join('\n') || '- (unknown)'}
`;
}

export const DICTIONARY_MD = `# Dictionary — ubiquitous language

One row per domain concept. Agents check this **before** inventing a new name, so
the same thing does not become \`Application\`, \`Request\`, and \`Submission\` in three
different files.

Format (kept greppable on purpose):

- **Term** — meaning · entity: \`Entity\` · table: \`db_table\` · api: \`/api/route\`

## Terms

<!-- add terms below -->
`;

export const ARCHITECTURE_MD = `# Architecture map

Filled in during bootstrap and updated when module boundaries actually change.

## Modules

## Data ownership

## Integration points
`;

export const CONVENTIONS_MD = `# Conventions

## Naming

## Git

## Migrations

## Tests
`;

export function guidelinesMd(ruleFiles) {
  const links = ruleFiles.length
    ? ruleFiles.map((f) => `- [\`${f}\`](../../${f})`).join('\n')
    : '- (no rule files found — add coding standards here or under .claude/rules/)';
  return `# Guidelines

TIMC does **not** copy coding standards. It links to the ones this repository
already has, so there is exactly one place to change them.

${links}
`;
}

export const ADR_INDEX_MD = `# ADR index

Generated. An ADR is created only when one of these is true: a new external
dependency, a change in data ownership, an irreversible migration, an effect on
two or more modules, or a security boundary. Everything else is a decision in
\`decisions.md\`.

| id | title | status | trigger |
|---|---|---|---|
`;

/** @returns {object} a fresh task.yaml document */
export function taskDoc({ id, title, intent, track, classification, branch }) {
  return {
    schema: 'timc/task@1',
    id,
    title,
    intent: intent ?? title,
    created: nowIso(),
    updated: nowIso(),
    track,
    classification,
    external: { sprint_ticket: null, branch, code_commits: [] },
    phase: 'CREATED',
    suspend: null,
    revision: 0,
    gates: {},
    steps: [],
    acceptance_criteria: [],
    open_questions: [],
    handoffs: [],
  };
}

export function interviewMd(task) {
  return `# Interview — ${task.id}

> ${task.title}

The interview is a **design tree worked in rounds**. The **frontier** is every
decision whose prerequisites are settled — ask that whole set in one round, each
question with your recommended answer, then wait. Answers reshape the tree and
push the frontier outward.

Finding **facts** is the agent's job: look them up, never ask the user something
the codebase can answer. **Decisions** are the user's. The interview closes when
the frontier is empty (\`timc frontier\`), not when it feels like enough.

Questions live in \`task.yaml\` (\`timc ask\` / \`timc answer\`); this file records the
understanding they produced.

## Codebase findings

_Facts established by looking, not by asking._

## Confirmed facts

## User decisions

## Constraints

## Assumptions

_One entry per assumption. Levels: CONFIRMED · ASSUMED · UNKNOWN._

## Rejected options

## Open questions

_A question left at high risk blocks the next phase. Lower the risk or get it answered._
`;
}

export function specMd(task) {
  return `---
schema: timc/spec@1
task: ${task.id}
schema_change: false
public_api_change: false
migration_required: false
security_relevant: false
assumptions: []
seams:
  - id: SEAM-1
    where: TODO            # the boundary the tests attach to
    kind: existing         # existing | new  (a new seam needs approved_by)
    tests: TODO            # prior art: similar tests already in the codebase
acceptance_criteria:
  - id: AC-1
    text: TODO
---

# Specification — ${task.id}

_Synthesis, not interview: this is written from what the interview already
settled. No file paths, no code snippets — they go stale within a week. The one
exception is a snippet that encodes a decision more precisely than prose can
(a state machine, a schema, a type shape); trim it to the decision._

## Problem statement

_From the user's perspective._

## Solution

_From the user's perspective._

## User stories

_Long and specific. "As an <actor>, I want <feature>, so that <benefit>."_

1. As a …, I want …, so that …

## Implementation decisions

_Modules built or changed, interfaces, schema changes, API contracts,
architectural decisions, clarifications from the developer._

## Seams and testing decisions

_Where does this get tested? Prefer an existing seam; use the highest seam you
can; the fewer seams the better — one is ideal. A new seam needs the user's
approval. Only external behaviour is tested, never implementation details._

| seam | where | existing/new | prior art |
|---|---|---|---|
| SEAM-1 | TODO | existing | TODO |

## Acceptance criteria

- **AC-1** — TODO

## Out of scope

## Business rules · Edge cases

## Security · Performance · Compatibility · Migration

## Known unknowns
`;
}

export function planMd(task) {
  return `# Plan — ${task.id}

Steps live in \`task.yaml\` (the machine-readable truth). This file explains the
shape of the plan for humans: ordering, risks, and why it is cut this way.

## How the work is cut

Each step is a **tracer bullet**: a narrow but *complete* path through every
layer (schema → API → UI → tests), demoable on its own, sized to fit one fresh
context window. Layer-shaped steps ("the domain model", "the API") are the
anti-pattern — nothing can validate them and nothing can demo them.

Prefactoring comes first: make the change easy, then make the easy change.

**Wide refactors are the exception.** One mechanical change whose blast radius
covers the codebase cannot land green as a slice. Sequence it instead:

\`\`\`
expand   → add the new form beside the old, nothing breaks
migrate* → move call sites in batches (per package/directory), CI green each time
contract → delete the old form once no caller remains
\`\`\`

Use \`--kind expand|migrate|contract\`; TIMC enforces the ordering.

## Slices

| step | delivers (end-to-end behaviour) | blocked by |
|---|---|---|

## Risks

## Out of scope
`;
}

export const DECISIONS_MD = `# Decisions

_Generated from \`task.yaml\`. Record decisions with \`timc decide\`, not by editing
this file:_

\`\`\`bash
timc decide "Can one payment have several partial refunds?" \\
  --decision "yes, capped at the captured amount" \\
  --reason "matches how the bank reports them" \\
  --type BUSINESS --by user --evidence Q-001
\`\`\`

A decision attributed to the user needs the answer that carries it
(\`--evidence Q-00N\` or \`events#seq=N\`) — otherwise TIMC rejects it.

_No decisions recorded yet._
`;

export const RISKS_MD = `# Risks

| id | risk | likelihood | impact | mitigation | status |
|---|---|---|---|---|---|
`;

export function implementationLogMd(task) {
  return `# Implementation log — ${task.id}

Append-only, human-readable chronology. Machine state lives in \`task.yaml\`.
`;
}

export function validationMd(task) {
  return `# Validation — ${task.id}

| acceptance | how it was verified | evidence | result |
|---|---|---|---|
`;
}
