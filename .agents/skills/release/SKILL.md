---
name: release
description: Prepare and open a deterministic Release PR from accumulated commits on main (or trigger manual workflow_dispatch release).
disable-model-invocation: true
---

# Release

## When to Use

- Run when ready to promote unreleased commits accumulated on `main` into a new stable `vX.Y.Z` release via a reviewable Release PR.
- Use `gh workflow run release.yml` instead when cutting a pure deterministic release directly on GitHub Actions without a Release PR.

## Steps

1. **Sync `main` and compute the deterministic release plan**
   Fetch tags and `origin/main`, inspect the range since the latest `v*` tag, and collect merged PR labels for that range:
   ```bash
   git fetch origin main --tags
   LATEST_TAG="$(git tag --list 'v*' --sort=-v:refname | head -n1)"
   RANGE_SHAS="$(git rev-list "${LATEST_TAG:+${LATEST_TAG}..}origin/main" | jq -R . | jq -s .)"
   PR_LABELS_JSON="$(gh pr list --state merged --base main --limit 100 --json mergeCommit,title,labels --jq --argjson shas "$RANGE_SHAS" '[.[] | select(.mergeCommit.oid as $oid | $shas | index($oid)) | {subject: .title, labels: [.labels[].name]}]')"
   bun run release:plan --from "$LATEST_TAG" --to origin/main --repo iqbal-codes/agy-multi --pr-labels-json "$PR_LABELS_JSON"
   ```
   Confirm `commitCount > 0` and verify the target `version` (`patch`/`minor`/`major`) unless the user explicitly requested a version override.
   *Completion Criterion*: Deterministic `previousTag`, `version`, `tag`, `commitCount`, and `commits` list are captured from `origin/main`.

2. **Create a clean release branch and run deterministic preparation**
   Create branch `release/v<version>` from `origin/main` and run `prepare --write`:
   ```bash
   git checkout -b "release/v<version>" origin/main
   bun run release:prepare --from "$LATEST_TAG" --version "<version>" --repo iqbal-codes/agy-multi --write
   ```
   *Completion Criterion*: `package.json` version equals `<version>` and `CHANGELOG.md` contains `## [<version>] - <YYYY-MM-DD>`.

3. **Curate the changelog summary without inventing facts**
   Review the generated `## [<version>]` section in `CHANGELOG.md`. Optionally add a concise 1-2 sentence overview paragraph above `### Breaking Changes` / `### Added` / `### Fixed` and polish wording using ONLY facts observed in the commits and PRs from Step 1. Keep the `[Full Changelog](...)` link intact.
   Verify the extracted GitHub Release notes output:
   ```bash
   bun src/release-plan.ts notes --version "<version>" --changelog CHANGELOG.md
   ```
   *Completion Criterion*: `notes` outputs the exact non-empty release body matching the commits in `<previousTag>..origin/main`.

4. **Run verification gates**
   Execute static checks and tests on the release branch:
   ```bash
   bun run typecheck
   bun run test
   ```
   *Completion Criterion*: Both `bun run typecheck` and `bun run test` exit with code 0.

5. **Commit, push, and open the Release PR**
   Commit `package.json` and `CHANGELOG.md` with message `chore(release): v<version>`, push the branch, and open a PR targeting `main` titled `chore(release): v<version>` using the curated changelog section as the PR body:
   ```bash
   git add package.json CHANGELOG.md
   git commit -m "chore(release): v<version>"
   git push -u origin "release/v<version>"
   gh pr create --base main --head "release/v<version>" --title "chore(release): v<version>" --body-file <(bun src/release-plan.ts notes --version "<version>" --changelog CHANGELOG.md)
   ```
   Report the PR URL to the user. Merging this PR automatically triggers `.github/workflows/release.yml` to tag `v<version>`, build the binaries, and publish the GitHub Release.
   *Completion Criterion*: The Release PR is open targeting `main` with title `chore(release): v<version>` and its URL is returned to the user.
