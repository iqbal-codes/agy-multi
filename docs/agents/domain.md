# Domain Models, Architecture & ADRs

- **Status:** Active
- **Last verified:** 2026-11-10

How planning, architecture, and implementation skills consume and maintain this repository's domain vocabulary, architectural decisions, and shared component patterns.

## Before exploring or designing, read these

- **`GLOSSARY.md`** at the repository root (or **`GLOSSARY-MAP.md`** in multi-context repositories, which points to each context's `GLOSSARY.md`).
- **`docs/architecture.md`**: settled technology stack, folder/module topology, and the shared reusable component/module catalog produced by `/animus-architecture`.
- **`docs/adr/`**: Architectural Decision Records covering the area you are about to modify (and `src/<context>/docs/adr/` in multi-context repositories).
- **`.animus/codebase-rules.json`**: enforced structural rules (`rules`) and canonical shared building blocks (`pattern_registry`) across backend, frontend, CLI, and database layers.

If `GLOSSARY.md`, `docs/architecture.md`, or `docs/adr/` do not exist yet, **proceed silently**. Do not flag their absence or create empty boilerplate upfront; `/animus-grill`, `/animus-spec`, and `/animus-architecture` establish them when domain terms and architectural boundaries are settled.

## File structure

Single-context repository (most repositories):

```text
/
├── GLOSSARY.md
├── docs/
│   ├── architecture.md
│   └── adr/
│       ├── 0001-event-sourced-orders.md
│       └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repository (presence of `GLOSSARY-MAP.md` at the root):

```text
/
├── GLOSSARY-MAP.md
├── docs/
│   ├── architecture.md
│   └── adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── GLOSSARY.md
    │   └── docs/adr/                 ← context-specific decisions
    └── billing/
        ├── GLOSSARY.md
        └── docs/adr/
```

## Use the canonical domain vocabulary

When naming a domain concept in a spec, ticket title, type definition, module seam, or test name, use the exact term defined in `GLOSSARY.md` (or the `Shared Product Spine` in `docs/brainstorm-*.md`). Avoid drifting to synonyms that the glossary or product spine rejects.

If a needed domain concept is missing from the glossary, treat that as a signal: either reuse existing project terminology or surface the new term during `/animus-grill` / `/animus-architecture` so it is recorded consistently.

## Reuse shared primitives and flag ADR conflicts

- Consult `docs/architecture.md` and `pattern_registry` in `.animus/codebase-rules.json` before creating new UI primitives, data adapters, or service helpers. Reuse registered shared components rather than duplicating patterns across slices.
- If a proposed change or implementation conflicts with an existing ADR in `docs/adr/`, surface the conflict explicitly rather than overriding it silently:

> _Contradicts ADR-0002 (postgres-for-write-model), but worth reopening because…_
