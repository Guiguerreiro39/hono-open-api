---
status: accepted
---

# Release-Please, Conventional Commits, and GHCR publishing

We cut a Release of this private application template with Google Release-Please. A push to `master` or `main` maintains one Release PR (`chore(master): release X.Y.Z` while the default branch is `master`) that updates `package.json` version and `CHANGELOG.md`. Merging that pull request tags `vX.Y.Z`, opens the GitHub Release, and publishes the existing Dockerfile as one multi-arch GHCR image (`linux/amd64`, `linux/arm64`) with SLSA build provenance. Conventional Commits are required on pull request titles and on local commits. The default-branch ruleset requires the `verify`, `integration`, `docker`, and `Lint PR Title (Conventional Commits)` checks. This supersedes only the registry-release sentence in ADR-0012. The CI `docker` job stays a smoke build.

## Considered Options

- **Changesets (`@changesets/cli`)**: Rejected because this template does not publish npm packages, and the `.changeset/` notes in the tree were never wired to a CLI.
- **semantic-release**: Rejected because it tags and publishes on every push to the default branch, with no Release PR to review.
- **Leave GHCR publishing entirely to starter adopters (ADR-0012)**: Rejected for this repository. The image, Compose topology, and CI smoke build from ADR-0012 stay. The template's own registry publish waits until a human merges the Release PR.
- **Pre-1.0 Release-Please bump flags** (`bump-minor-pre-major`, `bump-patch-for-minor-pre-major`): Omitted because the manifest is already `1.0.0`. A feature bumps the minor, a fix bumps the patch, and a breaking change bumps the major.
- **Biome on the pre-commit hook**: Rejected because this repo lints with ESLint.

## Consequences

- `release-please-config.json` and `.release-please-manifest.json` track the root package at `1.0.0` with `release-type: node`, `include-component-in-tag: false`, and `chore` hidden in `CHANGELOG.md`. `package.json` is `"private": true`.
- `.github/workflows/release.yml` runs on pushes to `master` and `main`. The container job runs only when `release_created == 'true'`, tags `X.Y.Z`, `X.Y`, `latest`, and `sha-<short>`, and pushes SLSA provenance with `actions/attest-build-provenance`.
- `.github/workflows/pr-title.yml` checks pull request titles. Squash-merge makes that title the commit the next Release reads. `.github/workflows/ci.yml` still smoke-builds and does not push an image.
- `lefthook.yml` runs `eslint --fix` on staged JS and TS, Commitlint on `commit-msg`, and `scripts/check-branch-push.sh` on `pre-push` for `main` and `master` (`ALLOW_DIRECT_MAIN_PUSH=1` bypasses the local guard). `lefthook` is pinned to `2.2.1` because `2.2.2` ships without npm provenance and `trustPolicy: no-downgrade` rejects that downgrade. `pnpm setup:ruleset` applies `docs/github-ruleset.json`.
- The ruleset targets `~DEFAULT_BRANCH`, blocks deletion and force-pushes, requires pull requests with zero approving reviews and resolved review threads, and lets repository admins (`RepositoryRole` `actor_id` 5) bypass. It does not lock the merge method.
- `renovate.json5` opens `chore(deps)` pull requests, groups Hono, Drizzle, AWS SDK, and the lint and commit tools, and automerges devDependency minor and patch updates when CI passes. The Renovate GitHub App has to be installed on the repository before that file does anything.
