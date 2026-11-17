import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");

describe("package metadata", () => {
  it("pins pnpm@10.19.0 packageManager and node >=24 engine", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      private?: boolean;
      version?: string;
      packageManager?: string;
      engines?: Record<string, string>;
      scripts?: Record<string, string>;
    };

    expect(pkg.private).toBe(true);
    expect(pkg.version).toBe("1.0.0");
    expect(pkg.packageManager).toBe("pnpm@10.19.0");
    expect(pkg.engines).toEqual({ node: ">=24" });
    expect(pkg.scripts?.prepare).toContain("lefthook install");
    expect(pkg.scripts?.["setup:ruleset"]).toBe("bash scripts/setup-github-rulesets.sh");
  });
});

describe("docker packaging", () => {
  it("excludes non-runtime and sensitive paths in .dockerignore", () => {
    const dockerignore = readFileSync(path.join(REPO_ROOT, ".dockerignore"), "utf8");
    const entries = new Set(
      dockerignore
        .split(/\r?\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.startsWith("#")),
    );

    for (const required of [
      ".git",
      "node_modules",
      "dist",
      ".env*",
      "*.db",
      "*.db-*",
      "tests",
      "docs",
      "coverage",
      ".storage",
    ]) {
      expect(entries.has(required), `missing .dockerignore entry: ${required}`).toBe(true);
    }
  });

  it("builds a multi-stage node:24-slim Dockerfile running as non-root node with exec PID 1 CMD", () => {
    const dockerfile = readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");

    expect(dockerfile).toMatch(/^FROM node:24-slim AS base$/m);
    expect(dockerfile).toContain("corepack enable");
    expect(dockerfile).toContain("pnpm@10.19.0");
    expect(dockerfile).toMatch(/^FROM base AS deps$/m);
    expect(dockerfile).toMatch(/^FROM deps AS build$/m);
    expect(dockerfile).toMatch(/^RUN .*pnpm build$/m);
    expect(dockerfile).toMatch(/^FROM base AS prod-deps$/m);
    expect(dockerfile).toMatch(/^RUN .*pnpm install --prod --frozen-lockfile$/m);
    expect(dockerfile).toMatch(/^FROM node:24-slim AS runtime$/m);
    expect(dockerfile).toMatch(/^ENV NODE_ENV=production$/m);
    expect(dockerfile).toContain("/data");
    expect(dockerfile).toContain("node:node");
    expect(dockerfile).toContain("COPY --from=build --chown=node:node /app/dist ./dist");
    expect(dockerfile).toContain("COPY --from=build --chown=node:node /app/src/infra/db/migrations ./src/infra/db/migrations");
    expect(dockerfile).toContain("COPY --from=build --chown=node:node /app/package.json ./package.json");
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).not.toMatch(/^HEALTHCHECK\b/m);
    expect(dockerfile).toMatch(/^CMD \["node", "dist\/src\/index\.js"\]$/m);
  });
});

describe("github actions ci workflow", () => {
  it("triggers on master/main push and pull_request with non-default-branch concurrency cancel", () => {
    const ciYaml = readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");

    expect(ciYaml).toContain("push:");
    expect(ciYaml).toContain("master");
    expect(ciYaml).toContain("main");
    expect(ciYaml).toContain("pull_request:");
    expect(ciYaml).toContain("concurrency:");
    expect(ciYaml).toContain("cancel-in-progress:");
    expect(ciYaml).toContain("refs/heads/master");
    expect(ciYaml).toContain("refs/heads/main");
  });

  it("defines verify, integration, and docker smoke jobs on Node 24 and pnpm", () => {
    const ciYaml = readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");

    expect(ciYaml).toContain("pnpm/action-setup@v4");
    expect(ciYaml).toContain("actions/setup-node@v4");
    expect(ciYaml).toMatch(/node-version:\s*["']?24["']?/);

    expect(ciYaml).toMatch(/^ {2}verify:$/m);
    expect(ciYaml).toContain("pnpm typecheck");
    expect(ciYaml).toContain("pnpm lint");
    expect(ciYaml).toContain("pnpm test");
    expect(ciYaml).toContain("pnpm build");
    expect(ciYaml).toContain("pnpm db:generate");
    expect(ciYaml).toContain("git diff --exit-code src/infra/db/migrations");

    expect(ciYaml).toMatch(/^ {2}integration:$/m);
    expect(ciYaml).toContain("docker compose up -d --wait redis s3 s3-init");
    expect(ciYaml).toContain("pnpm test:integration");
    expect(ciYaml).toContain("if: always()");
    expect(ciYaml).toContain("docker compose down");

    expect(ciYaml).toMatch(/^ {2}docker:$/m);
    expect(ciYaml).toContain("docker build");
    expect(ciYaml).not.toContain("docker push");
  });
});

describe("release pipeline", () => {
  it("has no leftover changeset notes", () => {
    const changesetDir = path.join(REPO_ROOT, ".changeset");
    if (!existsSync(changesetDir)) {
      return;
    }

    const notes = readdirSync(changesetDir).filter(name => name.endsWith(".md"));
    expect(notes).toEqual([]);
  });

  it("configures lefthook to eslint-fix staged files, commitlint, and the push guard", () => {
    const content = readFileSync(path.join(REPO_ROOT, "lefthook.yml"), "utf8");

    expect(content).toContain("pre-commit:");
    expect(content).toContain("stage_fixed: true");
    expect(content).toContain("eslint --fix");
    expect(content).toContain("commit-msg:");
    expect(content).toContain("commitlint --edit");
    expect(content).toContain("pre-push:");
    expect(content).toContain("scripts/check-branch-push.sh");
  });

  it("blocks direct pushes to main and master unless ALLOW_DIRECT_MAIN_PUSH=1", () => {
    const scriptPath = path.join(REPO_ROOT, "scripts/check-branch-push.sh");

    const run = (env: Record<string, string>, input?: string) => spawnSync("bash", [scriptPath], {
      // eslint-disable-next-line node/no-process-env -- the push guard test passes a child environment
      env: { ...process.env, ...env },
      encoding: "utf8",
      input,
    });

    const blockedMain = run({ GIT_BRANCH: "main", ALLOW_DIRECT_MAIN_PUSH: "0" });
    expect(blockedMain.status).toBe(1);
    expect(blockedMain.stderr).toContain("Direct pushes to 'main' are prohibited");
    expect(blockedMain.stderr).toContain("ALLOW_DIRECT_MAIN_PUSH=1");

    const blockedMaster = run({ GIT_BRANCH: "master", ALLOW_DIRECT_MAIN_PUSH: "0" });
    expect(blockedMaster.status).toBe(1);
    expect(blockedMaster.stderr).toContain("Direct pushes to 'master' are prohibited");

    const blockedStdin = run(
      { GIT_BRANCH: "feat/cool", ALLOW_DIRECT_MAIN_PUSH: "0" },
      "refs/heads/feature 1111 refs/heads/main 2222\n",
    );
    expect(blockedStdin.status).toBe(1);
    expect(blockedStdin.stderr).toContain("Direct pushes to 'refs/heads/main' are prohibited");

    expect(run({ GIT_BRANCH: "feat/some-feature", ALLOW_DIRECT_MAIN_PUSH: "0" }).status).toBe(0);
    expect(run({ GIT_BRANCH: "main", ALLOW_DIRECT_MAIN_PUSH: "1" }).status).toBe(0);
  });

  it("checks pull request titles with the eleven conventional commit types", () => {
    const content = readFileSync(path.join(REPO_ROOT, ".github/workflows/pr-title.yml"), "utf8");

    expect(content).toContain("pull_request_target:");
    expect(content).toContain("pull-requests: read");
    expect(content).toContain("Lint PR Title (Conventional Commits)");
    expect(content).toContain("amannn/action-semantic-pull-request@v6");
    expect(content).toMatch(/subjectPattern:\s*\^\(\?!\[A-Z\]\)\.\+\$/);

    for (const type of ["feat", "fix", "perf", "refactor", "docs", "style", "test", "build", "ci", "chore", "revert"]) {
      expect(content).toContain(type);
    }
  });

  it("configures Release-Please for the 1.0.0 root package without pre-major bump flags", () => {
    const config = JSON.parse(readFileSync(path.join(REPO_ROOT, "release-please-config.json"), "utf8")) as {
      packages: Record<string, {
        "release-type": string;
        "package-name": string;
        "changelog-path": string;
        "include-component-in-tag": boolean;
        "bump-minor-pre-major"?: boolean;
        "bump-patch-for-minor-pre-major"?: boolean;
        "changelog-sections": Array<{ type: string; hidden?: boolean }>;
      }>;
    };
    const rootPkg = config.packages["."];

    expect(rootPkg["release-type"]).toBe("node");
    expect(rootPkg["package-name"]).toBe("hono-open-api-starter");
    expect(rootPkg["changelog-path"]).toBe("CHANGELOG.md");
    expect(rootPkg["include-component-in-tag"]).toBe(false);
    expect(rootPkg["bump-minor-pre-major"]).toBeUndefined();
    expect(rootPkg["bump-patch-for-minor-pre-major"]).toBeUndefined();

    const chore = rootPkg["changelog-sections"].find(section => section.type === "chore");
    expect(rootPkg["changelog-sections"].map(section => section.type)).toEqual([
      "feat",
      "fix",
      "perf",
      "refactor",
      "docs",
      "build",
      "ci",
      "chore",
    ]);
    expect(chore?.hidden).toBe(true);

    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, ".release-please-manifest.json"), "utf8")) as Record<string, string>;
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
    expect(manifest["."]).toBe(pkg.version);
  });

  it("publishes a multi-arch GHCR image with SLSA provenance only after a Release is created", () => {
    const content = readFileSync(path.join(REPO_ROOT, ".github/workflows/release.yml"), "utf8");

    expect(content).toContain("main");
    expect(content).toContain("master");
    expect(content).toContain("cancel-in-progress: false");
    expect(content).toContain("contents: write");
    expect(content).toContain("pull-requests: write");
    expect(content).toContain("packages: write");
    expect(content).toContain("id-token: write");
    expect(content).toContain("attestations: write");
    expect(content).toContain("googleapis/release-please-action@v4");
    expect(content).toContain("config-file: release-please-config.json");
    expect(content).toContain("manifest-file: .release-please-manifest.json");
    expect(content).toContain("publish-container:");
    expect(content).toMatch(/needs\.release\.outputs\.release_created\s*==\s*'?true'?/);
    expect(content).toContain("docker/setup-qemu-action@v3");
    expect(content).toContain("linux/amd64,linux/arm64");
    expect(content).toContain("docker/setup-buildx-action@v3");
    expect(content).toContain("ghcr.io/${" + "{ github.repository }}");
    expect(content).not.toMatch(/ghcr\.io\/[^$]+hono-open-api/);
    expect(content).toContain("docker/metadata-action@v5");
    expect(content).toContain("type=semver,pattern={{version}}");
    expect(content).toContain("type=semver,pattern={{major}}.{{minor}}");
    expect(content).toContain("type=raw,value=latest");
    expect(content).toContain("type=sha,prefix=sha-");
    expect(content).toContain("docker/build-push-action@v6");
    expect(content).toContain("cache-from: type=gha");
    expect(content).toContain("cache-to: type=gha,mode=max");
    expect(content).toContain("actions/attest-build-provenance@v2");
    expect(content).toContain("push-to-registry: true");
  });

  it("requires verify, integration, docker, and the PR title check on the default branch", () => {
    const ruleset = JSON.parse(readFileSync(path.join(REPO_ROOT, "docs/github-ruleset.json"), "utf8")) as {
      target: string;
      enforcement: string;
      conditions: { ref_name: { include: string[] } };
      rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
      bypass_actors: Array<{ actor_id: number; actor_type: string; bypass_mode: string }>;
    };

    expect(ruleset.target).toBe("branch");
    expect(ruleset.enforcement).toBe("active");
    expect(ruleset.conditions.ref_name.include).toContain("~DEFAULT_BRANCH");
    expect(ruleset.rules.map(rule => rule.type)).toEqual([
      "deletion",
      "non_fast_forward",
      "pull_request",
      "required_status_checks",
    ]);

    const pullRequest = ruleset.rules.find(rule => rule.type === "pull_request");
    expect(pullRequest?.parameters?.required_approving_review_count).toBe(0);
    expect(pullRequest?.parameters?.required_review_thread_resolution).toBe(true);
    expect(pullRequest?.parameters).not.toHaveProperty("allowed_merge_methods");

    const checks = ruleset.rules.find(rule => rule.type === "required_status_checks");
    const contexts = (checks?.parameters?.required_status_checks as Array<{ context: string }>).map(check => check.context);
    expect(contexts).toEqual([
      "verify",
      "integration",
      "docker",
      "Lint PR Title (Conventional Commits)",
    ]);
    expect(ruleset.bypass_actors).toContainEqual({
      actor_id: 5,
      actor_type: "RepositoryRole",
      bypass_mode: "always",
    });

    const dryRun = spawnSync("bash", [path.join(REPO_ROOT, "scripts/setup-github-rulesets.sh"), "--dry-run"], {
      encoding: "utf8",
    });
    expect(dryRun.status).toBe(0);
    expect(dryRun.stdout).toContain("[Dry Run]");
    expect(dryRun.stdout).toContain("docs/github-ruleset.json");
  });

  it("keeps Renovate on chore(deps) with this repo's groups and devDependency automerge", () => {
    const content = readFileSync(path.join(REPO_ROOT, "renovate.json5"), "utf8");

    expect(content).toContain("config:recommended");
    expect(content).toContain(":semanticCommits");
    expect(content).toContain(":separateMultipleMajorReleases");
    expect(content).toContain("\"semanticCommitType\": \"chore\"");
    expect(content).toContain("\"semanticCommitScope\": \"deps\"");
    expect(content).toContain("hono ecosystem");
    expect(content).toContain("drizzle ecosystem");
    expect(content).toContain("aws sdk");
    expect(content).toContain("lint and commit tools");
    expect(content).toContain("\"automerge\": true");
    expect(content).toContain("\"devDependencies\"");
    expect(content).not.toContain("@tanstack/");
  });
});
