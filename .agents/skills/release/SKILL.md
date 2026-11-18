---
name: release
description: Cut a stable vX.Y.Z release by dispatching the release.yml workflow.
disable-model-invocation: true
---

# Release

## When to Use

- Run when unreleased commits have accumulated on `main` and the user asks to release.
- `.github/workflows/release.yml` is the only release path: it bumps `package.json`, writes `CHANGELOG.md`, tags `vX.Y.Z`, builds the binaries, and publishes the GitHub Release. There are no Release PRs and no release labels.

## Steps

1. **Sync `main` and compute the deterministic release plan**
   Fetch tags and `origin/main`, then derive the next version from the commits since the latest `v*` tag:
   ```bash
   git fetch origin main --tags
   LATEST_TAG="$(git tag --list 'v*' --sort=-v:refname | head -n1)"
   bun run release:plan --from "$LATEST_TAG" --to origin/main --repo iqbal-codes/agy-multi
   ```
   Confirm `commitCount > 0` and use the computed `version` unless the user explicitly requested an override.
   *Completion Criterion*: Deterministic `previousTag`, `version`, `tag`, `commitCount`, and `commits` list are captured from `origin/main`.

2. **Dispatch the release workflow**
   ```bash
   gh workflow run release.yml --ref main -f bump=auto
   # Explicit bump: -f bump=minor (or major/patch)
   # Explicit version: -f version=0.6.0
   ```
   Add `-f dry_run=true` to preview the computed version and notes without committing, tagging, or publishing.
   *Completion Criterion*: `gh run list --workflow release.yml --limit 1` shows a queued or in-progress run.

3. **Watch the run to completion**
   ```bash
   RUN_ID="$(gh run list --workflow release.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
   gh run watch "$RUN_ID" --exit-status
   ```
   *Completion Criterion*: The run concludes `success` and `gh release view v<version>` shows the published release with its assets.

Report the release URL from `gh release view v<version> --json url --jq .url`.
