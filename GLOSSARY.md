# agy-multi

A multi-account router and ACP proxy for the official Antigravity CLI (`agy`).

## Language

**Profile**:
An isolated Antigravity installation with its own credentials, metadata, and caches, either managed under the agy-multi root or adopted from an existing home directory.
_Avoid_: Account config, user slot

**Account Pool**:
The collection of configured Profiles together with their quota blocks, model-catalog reservations, health flags, and ranking order.
_Avoid_: Pool manager, account service

**Model Catalog**:
The merged set of public Gemini models, selector choices, and cached reasoning-effort options known across Profiles.
_Avoid_: Model registry, model list

**Probe**:
A short-lived background invocation of `agy` that refreshes a Profile's quota snapshot, model list, or reasoning-effort metadata without starting a user turn.
_Avoid_: Health check, poll worker

**Session Ledger**:
The authoritative mapping between a stable client-facing ACP session ID, its current owning Profile and child conversation ID, its transcript history, and its on-disk record.
_Avoid_: Session store, session manager

**Handoff**:
Moving an ACP session from one Profile to another between turns (or before streamed output), preferring native conversation resume on the shared store and falling back to verbatim transcript replay.
_Avoid_: Failover migration, session transfer

**Turn Supervisor**:
The controller of a single in-flight ACP prompt turn, responsible for mirrored stream tracking, Daemon Hold continuations, post-turn Auto-Compaction, and token-usage updates.
_Avoid_: Prompt runner, turn handler

**Daemon Hold**:
Keeping an ACP turn open with continuation prompts while background tasks started by the agent are still running, because ACP clients cannot wake an agent after a turn ends.
_Avoid_: Background wait loop

**Auto-Compaction**:
An automatic, output-suppressed `/compact` prompt triggered after a turn when measured transcript token usage reaches the configured compaction threshold.
_Avoid_: Context cleanup
