# agy-multi — Autonomous Software Factory Agent Instructions

## Core Philosophy

- **Effective > cheap**: Ship production-grade solutions with complete edge-case coverage.
- **Fail closed**: Hold unverified or unlabeled work; fail closed on errors to preserve execution safety.
- **Progressive disclosure**: Keep base instructions lean (<= 150 lines); consult specialized context pointers below when triggered.

## Repository Knowledge, Skills & Memory

- **Canonical Configuration**: `AGENTS.md` and `.agents/skills/` are authoritative sources of truth (`CLAUDE.md -> AGENTS.md`, `.claude/skills -> ../.agents/skills`).
- **Stage & Workflow Boundary**: Stage playbooks in `.agents/skills/` (`animus-*`, `retro`, `pr`, `skill-creator`, `writing-for-agents`) are **strictly user- or engine-invoked (`disable-model-invocation: true`)**. Never self-invoke, read, chain, or combine stage playbooks unless explicitly requested for the current turn.
- **Verified Tool Guidance**: Inspect `.animus/tool-guidance.json` for validated CLI recipes (`static`: `bun run typecheck`, `unit`: `bun run test`).
- **Evidence-Backed Lessons**: Inspect `.animus/lessons.jsonl` for repository-specific gotchas matching target files before editing.
- **Harness Authoring Standard**: Adhere to `docs/agents/harness-authoring-standard.md` when curating lessons, rules, or skills.
- **Harness Safe Mode**: Bypass dynamic harness memory and use base tooling when `.animus/NO_HARNESS_MEMORY` is present.

## Domain & Workflow Documentation

- **PR & Evidence Contract**: Read `docs/agents/pr-evidence-contract.md` for canonical PR bodies, release bump labels (`release:minor` / `release:major`), evidence matrices, Before/After captures, and finding rechecks.
- **Issue Tracker, Dependencies & Triage Labels**: Read `docs/agents/issue-tracker.md` for `gh` conventions, `Depends on:` rules, and canonical triage labels (`ready-for-agent`, `needs-info`, `ready-for-human`, `needs-triage`, `wontfix`, `spec`, `needs-owner`). Labels are visibility hints; admission is frozen at import and dependency release requires verified lineage, never issue closure.
- **Domain Models & ADRs**: Read `docs/agents/domain.md`, `GLOSSARY.md`, and `docs/adr/` before modifying domain models or architectural boundaries.
- **Document Lifecycle**: `docs/README.md` indexes every document with `Status: Active|Draft|Historical|Superseded`. Implement only from `Active`; treat `Historical` and `Superseded` as provenance, follow the named replacement for superseded work, and never add an unindexed file under `docs/`.

## Execution Rules

- **Red -> Green Loop**: Write failing tests first at agreed public seams using `.agents/skills/tdd/SKILL.md`, then implement minimal passing code.
- **Blueprint & Two-Strike Unstick**: Compile domain types and stub signatures before bodies (`.agents/skills/blueprint/SKILL.md`). After 2 consecutive check failures, stop editing, probe the shared assumption, and revert scratch debris (`.agents/skills/unstick/SKILL.md`).
- **Protected Governance Paths**: Keep `harness/**`, `.animus/holdout/**`, and `.animus/hooks/**` untouched during delivery laps.
- **Clean Cutover**: Migrate all callers when modifying contracts; keep one canonical implementation without deprecated shims.
