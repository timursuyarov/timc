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

## Codebase findings

_What was inspected before asking anything._

## Questions asked

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
acceptance_criteria:
  - id: AC-1
    text: TODO
---

# Specification — ${task.id}

## Problem

## Goal

## Scope

## Non-goals

## Actors

## Functional requirements

## Business rules

## Edge cases

## Acceptance criteria

- **AC-1** — TODO

## Security · Performance · Compatibility · Migration

## Known unknowns
`;
}

export function planMd(task) {
  return `# Plan — ${task.id}

Steps live in \`task.yaml\` (the machine-readable truth). This file explains the
shape of the plan for humans: ordering, risks, and why it is cut this way.

## Approach

## Ordering / dependencies

## Risks

## Out of scope
`;
}

export const DECISIONS_MD = `# Decisions

\`\`\`yaml
# - id: DEC-001
#   date: 2026-01-01
#   type: IMPLEMENTATION      # BUSINESS | ARCHITECTURE | IMPLEMENTATION | TEMPORARY_ASSUMPTION
#   question: …
#   options: [ …, … ]
#   decision: …
#   reason: …
#   decision_maker: user      # user | agent:<role>
#   evidence: events#seq=0    # REQUIRED when decision_maker is user
#   reversible: true
\`\`\`
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
