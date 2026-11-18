# Canonical PR Evidence and Review Contract

- **Status:** Active
- **Last verified:** 2026-11-18

Authoritative specification for human-friendly PR bodies (`.agents/skills/pr/SKILL.md`), Before/After captures, inline diff findings, and status comments across Animus.

## Authority and Host Ownership

- **Host owns publication and state transitions**: The engine/host orchestrator pins commit identities, validates evidence files, renders delimited PR sections, and posts inline review comments. Agents supply structured observations and local artifact paths; agent text never conveys merge authority or changes lifecycle state.
- **QA blindfold & fast-fail**: Black-box QA evaluates acceptance criteria (`AC1..ACn`) against an isolated integration checkout without reading builder PR prose. If QA fails, the loop fast-fails (`sent_back`) immediately to the builder without invoking the Code Reviewer.
- **1-Axis Code & Architecture Review**: Once QA passes, the Code Reviewer inspects the line-numbered `git diff` against `CODING_STANDARDS.md`, `.animus/codebase-rules.json`, external blast radius, module depth, and test quality, posting line-by-line inline diff comments and a summary verdict.

## Identity Distinctions and Candidate Binding

Evidence claims bind to exact, immutable Git identities:

- **Target-base tip**: Latest commit on the target integration branch (`main` or `develop`).
- **Merge-base**: Common ancestor commit (`git merge-base <base> <head>`).
- **PR head**: Author's candidate commit on the feature branch.
- **Tested identity**: The exact commit or isolated integration SHA executed during verification.
- **Candidate invalidation**: Code edits, branch re-pushes, or base rebases invalidate affected evidence.

## Human-Friendly PR Body Structure (`$pr`)

Published PR bodies lead with visual clarity for humans while keeping machine-validated tables inside a collapsible `<details>` block within `<!-- BEGIN_FACTORY_EVIDENCE_INDEX -->`:

```markdown
Closes #<issue>

## Summary

<Plain-English summary using domain language + smallest visual: diff-sketch, call-tree, pseudocode, file tree, or Mermaid>

## Problem and Outcome

<Source issue/spec link and delivered outcome.>

## Invariants

- <Preserved system property or boundary rule.>

## Review Guidance (Start here)

- <Key entrypoints and architectural tradeoffs.>

## Changed Seams

- `<module/API/CLI>`: <old -> new contract and caller impact.>

## Evidence

- **Before:** <baseline behavior, failing test output, or screenshot>
- **After:** <delivered behavior, passing test output, or screenshot>

<!-- BEGIN_FACTORY_EVIDENCE_INDEX -->
<details>
<summary>Verification matrix & candidate metadata</summary>

PR head: `<full SHA>`; selected base: `<full SHA>`; merge-base: `<full SHA>`.
Tested identity: `<tested candidate or isolated integration SHA>`.
Environment: <OS, runtime, fixture vs live external mocks>.

| Criterion / scenario | Result | Observed behavior | Check / artifact |
| --- | --- | --- | --- |
| <source AC ID> | <PASS/FAIL/BLOCKED/NOT RUN> | <actual assertion or failure details> | <command/scenario; evidence ID/path> |

</details>

### Before / After

| Scenario | Before | After |
| --- | --- | --- |
| <matched scenario/route/state> | <observation + baseline image or honest N/A> | <observation + candidate image> |

**Outstanding:** <failures, unavailable evidence, unrun checks, or None.>

### Judge Alterations (Requires Approval)
None.
<!-- END_FACTORY_EVIDENCE_INDEX -->

## Merge Danger

**Door:** <Two-way door (reversible) | One-way door (migration / breaking contract)>
**Blast Radius:** <Low / Moderate / High — affected callers and rollback notes>
```

## Inline Diff Review & Comment Lifecycle

- **Quiet When Clean (`approved` / `merged`)**: When QA and Code Review pass with zero findings, the PR review comment is a concise 3–5 line LGTM summary with Auto-Merge / Critical Impact gate status.
- **Sharp When Fixing (`sent-back`)**: When the Code Reviewer identifies defects on specific diff lines (`L<line>:`), the host publishes inline GitHub PR review comments directly on the affected `file` and `line` (with optional ````suggestion```` blocks) plus a summary checklist at the bottom of the PR.

## Releases

Releases are cut only by running `.github/workflows/release.yml` via `workflow_dispatch`. Merged commits accumulate on `main` until a maintainer dispatches the workflow with `bump=auto|patch|minor|major` or an explicit `version`; the workflow derives the next version from Conventional Commit titles (`feat:`, `feat!:`, `fix:`), updates `package.json` and `CHANGELOG.md`, tags `vX.Y.Z`, builds the binaries, and publishes the GitHub Release. There are no Release PRs and no release labels.
