# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases are
tagged by the release workflow on merge to `main`.

## [Unreleased]

### Added

- `agy-multi update` replaces the installed `agy-multi` and `agy-multi-acp`
  binaries with the latest GitHub release. It picks the archive for the running
  platform, verifies its SHA-256 against the release digest (falling back to
  `SHA256SUMS.txt`), and refuses to install when the downloaded binary does not
  report the release's version — so a corrupt or mismatched archive leaves the
  installed copy untouched. `--check` reports without installing; `--force`
  reinstalls the current version. Running sessions keep the previous binary
  until they restart, and `~/.agy-multi` state is never touched.
- `agy-multi --version` prints the version this build reports. `package.json` is
  inlined at bundle time, so a compiled single-file binary can answer it.

## [0.3.0] - 2026-11-17

This release makes one account per process the default, keeps the previous
automatic failover behind an explicit flag, and lets a conversation follow you
across accounts.

### Added

- `agy-multi use <slug>` records the account to serve in `state.json`
  (`defaultProfile`). The state file moves to schema v2; v1 files load unchanged.
- `--allow-account-pool` restores the previous automatic failover and warns about
  Google's Antigravity Terms before serving the first request.
- `--sequential` (pool only): keeps exactly one `agy acp` child alive. Ranking
  reads cached `/usage` and model catalogs instead of probing every account, and
  the previous child is stopped with its exit awaited (`AcpChild.stop()`).
- `--switch-delay <seconds>` (pool only): pauses before handing a turn to another
  account. Default 20 seconds.
- `--handoff-context <chars>`: caps the transcript replay used when a conversation
  cannot be resumed. Default is the whole conversation.
- Shared conversation store: `brain/`, `conversations/` and `history.jsonl` are
  linked from every profile HOME into `<root>/shared/gemini` with relative
  symlinks, so switching accounts keeps the thread. Existing per-profile data is
  migrated on the next `agy-multi sync` or ACP start; colliding conversation ids
  are preserved in `shared/gemini/migrated`.
- Cross-account continuation: a handoff tries `session/resume` on the shared store
  first, so the new account opens the same conversation instead of receiving a
  replay.
- `extractFlagArg` helper for `--name value` / `--name=value` parsing.

### Changed

- Each process now serves the account you selected (`--profile` or
  `agy-multi use`). Quota, suspension and sign-out failures are reported with the
  reset time and the command to switch by hand; the wrapper no longer rotates on
  its own.
- Model reservation is pool-only and health-aware: an account that is banned,
  signed out, disabled, quota-blocked, or under the reserve no longer holds its
  wider catalog back from a baseline model it could serve.
- Sequential mode places a new session on the account that is currently mid-turn
  (even below the reserve) instead of attempting a switch it would refuse.
- Handoff replay is verbatim: `User:` / `Assistant:` turns only — no framing
  line, no "continue" instruction, no account narrative, no synthesized
  `[used tools: …]`, no `(interrupted: …)` suffix, and no truncation by default.
- A migration attempt only falls through to the next account on a
  model-unsupported error; every other failure reaches the client intact.
- State root moved from `~/.agy` to `~/.agy-multi`, migrated once at startup by an
  atomic rename. A directory that is not an agy-multi root is never touched, and
  a failed move keeps using the legacy root instead of losing state.
- Package description and installer hints reflect the single-account default.
- README restructured around the pinned default, with pool mode, sequential mode,
  reservation and handoff semantics documented.

### Fixed

- Sequential mode could kill another account's in-flight turn. It now refuses the
  switch with `sequential mode: account <slug> is mid-turn`.
- Sequential mode probed every account on each ranking decision, which defeated
  the point of keeping one account active.
- A reserved baseline model became unservable once the account that owned it was
  blocked, even though the wider catalog could serve it.
- `stopOtherChildren` could return before the previous agent was gone; the new
  `AcpChild.stop()` settles when the process has actually exited.

### Removed

- `[used tools: …]` summaries from the persisted assistant history. Tool calls are
  not part of a conversation that crosses accounts, and inventing text for them
  changed what the next account saw.
