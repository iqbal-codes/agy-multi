# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0), and releases are
published only by running `.github/workflows/release.yml` via `workflow_dispatch`.

## [Unreleased]

### Changed

- handoff pacing defaults to 10 seconds instead of 20, for `acp` and `run`;
  `--switch-delay <seconds>` still overrides it and `0` disables the pause.

### Fixed

- `agy-multi acp` no longer dies when concurrent agents provision the same
  profile HOME: the shared conversation store tolerated neither a competing
  `rename` nor a competing `symlink`, so the loser exited 1 and ACP clients
  reported a failed test session instead of the real error.

## [1.0.0] - 2026-11-18

### Breaking Changes

- default to account-pool and remove manual mode (#10)

### Maintenance

- **release**: make workflow dispatch the only release path (#11)
  - Drop the push-triggered Release PR flow and release:* bump labels.
  - Derive the bump from Conventional Commit titles only; remove detect-release-pr, pick, and --pr-labels-json.
  - Commit the version and changelog, tag, build, and publish in one workflow run.
  - Update the /release skill, PR template, and release docs to match.
- run CI checks on ubuntu-latest only (#9)
- **release**: deterministic range-based release pipeline (#8)
  * ci(release): deterministic range-based release pipeline

  * ci(release): remove PR release plan workflow

[Full Changelog](https://github.com/iqbal-codes/agy-multi/compare/v0.5.2...v1.0.0)

## [0.5.2] - 2026-11-18

### Fixed

- `agy-multi` no longer asks macOS for the per-profile keychain. The auth check
  behind every usage/model probe ran `security find-generic-password`, which
  raises the "agy-multi wants to use the keychain" password dialog as soon as
  that keychain locks. The check is filesystem-only now; a stale token shows up
  as an auth error from the CLI, which the proxy already classifies.

## [0.5.1] - 2026-11-18

### Changed

- The proxy no longer probes an account when a session closes. The turn-end
  refresh already covers it, and the extra check only fired for sessions that
  never did any work.

## [0.5.0] - 2026-11-18

This release lets an installed copy update itself and answer `--version` without
guessing.

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

## [0.4.0] - 2026-11-18

This release stops starting a CLI just to read a number: quota and usage come
from a cached snapshot the proxy keeps for the accounts that actually run, and
no probe ever fans out across accounts.

### Changed

- Quota reads are cache-only. `agy-multi quota` and `agy-multi multi-usage`
  print the snapshot the proxy already synced (milliseconds, no child process);
  `--refresh` re-probes on demand, still one account at a time. A cold cache says
  so instead of quietly starting a check.
- Nothing sweeps the account list any more. An account is refreshed when it
  starts serving work and again when that session or child ends, and the cache
  TTL decides whether a probe runs at all; idle accounts are never touched.
- `agy-multi profile add` and `profile login` record the account's first quota
  snapshot right after the login check, so a freshly added account already shows
  its headroom instead of `(no cached usage)`.

### Fixed

- Nothing probes more than one account at a time. Ranking, reservation, the
  ACP `/multi-usage` command, and one-shot runs read caches and hand refreshes
  to a single serial queue, replacing the `Promise.all` fan-outs that could boot
  a CLI per account at once.
- A quota probe that hits the CLI's interactive-login fallback is killed at once
  and its account is marked signed-out, instead of hanging until the 30 s
  timeout while a browser login may start. The marker is only honoured past the
  probe's own start offset, so an old line cannot poison a healthy check.

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
