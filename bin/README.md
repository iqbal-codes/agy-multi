# bin

## Overview

Four two-line shims — POSIX `sh` and `cmd.exe` — run the repository's
TypeScript entry points under Bun, forwarding arguments to `bun run`.

| Launchers | Target |
| --- | --- |
| [`agy-multi`](agy-multi), [`agy-multi.cmd`](agy-multi.cmd) | [`../src/index.ts`](../src/index.ts) |
| [`agy-multi-acp`](agy-multi-acp), [`agy-multi-acp.cmd`](agy-multi-acp.cmd) | [`../src/acp-bin.ts`](../src/acp-bin.ts), serving the ACP sources in [`../src/acp/`](../src/acp/) |

## Interface

| Launcher | Line 1 | Line 2 |
| --- | --- | --- |
| `agy-multi` | `#!/usr/bin/env sh` | `exec bun run "$(dirname "$0")/../src/index.ts" "$@"` |
| `agy-multi-acp` | `#!/usr/bin/env sh` | `exec bun run "$(dirname "$0")/../src/acp-bin.ts" "$@"` |
| `agy-multi.cmd` | `@echo off` | `bun run "%~dp0\..\src\index.ts" %*` |
| `agy-multi-acp.cmd` | `@echo off` | `bun run "%~dp0\..\src\acp-bin.ts" %*` |

- `"$@"`: one word per positional parameter, keeping boundaries and empty
  arguments; `%*`: the argument tail as typed, after `cmd.exe` percent-expansion.
- `$(dirname "$0")` and `%~dp0` are the launcher's own directory, so targets
  stay script-relative and quoted, and neither canonicalizes links; `bun`, plus
  POSIX `sh` and `dirname`, comes from the caller's `PATH` with no fallback.
- cwd is never changed, so Bun starts in the caller's directory, not `bin/`;
  targets run as `bun run <file>.ts`, never from `dist/`.

## Invariants

- Pure forwarding: no parsing, environment mutation, path rewriting, logging,
  redirection, or retries; argument channels stay `"$@"` and `%*` verbatim.

## Side Effects

- POSIX: `exec` replaces the shell image, so no wrapper remains and the caller
  sees Bun's exit status and streams; caught signals reset at `exec`, ignored
  ones stay ignored.
- Windows: `cmd.exe` stays the parent and waits; each file ends on its `bun`
  line with no `exit /b`, so the errorlevel is that command's.
- No filesystem, network, lock, cache, or credential effects originate here.

## Verification

From the repository root:
```sh
bun test
bun run typecheck
```
