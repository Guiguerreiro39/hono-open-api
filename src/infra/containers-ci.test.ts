import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");

describe("package metadata", () => {
  it("pins pnpm@10.19.0 packageManager and node >=24 engine", () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      packageManager?: string;
      engines?: Record<string, string>;
    };

    expect(pkg.packageManager).toBe("pnpm@10.19.0");
    expect(pkg.engines).toEqual({ node: ">=24" });
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
