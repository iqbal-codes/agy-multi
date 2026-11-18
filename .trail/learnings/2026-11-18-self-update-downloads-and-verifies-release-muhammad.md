---
title: Self-update downloads the published release and verifies it before swapping
author: muhammad iqbal
date: 2026-11-18
branch: main
id: l-344b3cc8
scope: repo
status: active
src: agent
touches:
  - src/update.ts
  - src/version.ts
  - src/index.ts
  - tsconfig.json
---

## Decided
- `agy-multi update` installs the latest GitHub release rather than rebuilding from source: it picks `agy-multi-<os>-<arch>.tar.gz`/`.zip` out of the release's asset list, verifies SHA-256 against GitHub's `digest` field (falling back to `SHA256SUMS.txt`), extracts to a temp dir, and only replaces the installed `agy-multi` + `agy-multi-acp` after the downloaded binary answers `--version` with the release's version. Fail closed at every step: a corrupt archive, a missing checksum, or a version mismatch leaves the installed copy untouched.
- Swap is a same-directory `rename` (copy into the install dir first, because rename across devices fails). POSIX renames over a running executable; Windows cannot, so the old file is renamed aside and deleted once the holder exits.
- The version comes from `import pkg from "../package.json"` in `src/version.ts` — Bun inlines JSON imports at bundle time, so a single-file compile can still report it. This needed `resolveJsonModule` in `tsconfig.json` for `tsc --noEmit`.
- Source and `bun install -g` installs are refused (with the command to run instead): they have no installed binary to replace.
## Watch out
- The `--version` probe means an update can only land on a release that supports `--version`. Releases from before this feature fail the probe ("would not run"), which is the intended fail-closed behavior — but it is why `--force` against an older tag cannot work.
- macOS ad-hoc signing (`codesign -s - -f`, as `install.sh` does) rewrites the binary, so the installed file's hash does not equal the release archive's. Verify an install by signing a copy of the release binary the same way and comparing, never by raw archive bytes.
- Detect "compiled binary" via `import.meta.url.includes("$bunfs")`; `process.execPath` is the bun runtime when run from source and the binary itself when compiled. Resolve symlinks on it before picking the install directory.

In the code: `src/update.ts` (`installLatestRelease`, `runUpdateCommand`, `isCompiledBinary`), `src/version.ts`, command wiring in `src/index.ts`, tests in `test/update.test.ts`.
