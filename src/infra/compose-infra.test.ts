import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseEnv } from "@/env";
import { getIntegrationEnv } from "../../tests/integration/env";

const REPO_ROOT = path.resolve(__dirname, "../..");

function extractServiceBlock(composeYaml: string, serviceName: string): string {
  const lines = composeYaml.split(/\r?\n/);
  let inServices = false;
  let capturing = false;
  const block: string[] = [];

  for (const line of lines) {
    if (!inServices) {
      if (line === "services:") {
        inServices = true;
      }
      continue;
    }

    if (/^\S/.test(line)) {
      break;
    }

    const serviceHeader = line.match(/^ {2}([\w-]+):$/);
    if (serviceHeader) {
      if (capturing) {
        break;
      }
      if (serviceHeader[1] === serviceName) {
        capturing = true;
        block.push(line);
      }
      continue;
    }

    if (capturing) {
      block.push(line);
    }
  }

  return block.join("\n");
}

describe("integration env defaults", () => {
  it("provides local Compose Redis and RustFS S3 defaults", () => {
    const env = getIntegrationEnv({}, {});

    expect(env).toEqual({
      REDIS_URL: "redis://localhost:6379",
      STORAGE_DRIVER: "s3",
      S3_BUCKET: "app-uploads",
      S3_REGION: "us-east-1",
      S3_ENDPOINT: "http://localhost:9000",
      S3_PUBLIC_ENDPOINT: "http://localhost:9000",
      S3_ACCESS_KEY_ID: "rustfsadmin",
      S3_SECRET_ACCESS_KEY: "rustfsadmin",
      S3_FORCE_PATH_STYLE: "true",
    });
  });

  it("layers baseEnv and explicit overrides without mutating inputs", () => {
    const baseEnv: Record<string, string | undefined> = {
      REDIS_URL: "redis://ci-redis:6379",
      S3_BUCKET: "",
      UNRELATED_SHELL_VAR: "ignored",
    };
    const overrides: Record<string, string | undefined> = {
      S3_BUCKET: "custom-bucket",
      S3_PUBLIC_ENDPOINT: undefined,
      CACHE_PREFIX: "int-test",
    };

    const env = getIntegrationEnv(overrides, baseEnv);

    expect(env.REDIS_URL).toBe("redis://ci-redis:6379");
    expect(env.S3_BUCKET).toBe("custom-bucket");
    expect(env.S3_PUBLIC_ENDPOINT).toBeUndefined();
    expect(env.CACHE_PREFIX).toBe("int-test");
    expect(env).not.toHaveProperty("UNRELATED_SHELL_VAR");
    expect(baseEnv.S3_BUCKET).toBe("");
    expect(baseEnv.CACHE_PREFIX).toBeUndefined();
  });

  it("keeps empty baseEnv strings from erasing integration defaults", () => {
    const env = getIntegrationEnv({}, { S3_BUCKET: "" });

    expect(env.S3_BUCKET).toBe("app-uploads");
  });
});

describe("compose infra scaffold", () => {
  it("keeps .env.test isolated without REDIS_URL or S3_BUCKET", () => {
    const envTest = readFileSync(path.join(REPO_ROOT, ".env.test"), "utf8");

    expect(envTest).not.toMatch(/^REDIS_URL=/m);
    expect(envTest).not.toMatch(/^S3_BUCKET=/m);
    expect(envTest).not.toMatch(/^STORAGE_DRIVER=/m);
  });

  it("defines redis, rustfs s3, and idempotent s3-init matching integration defaults", () => {
    const composeYaml = readFileSync(path.join(REPO_ROOT, "docker-compose.yml"), "utf8");
    const env = getIntegrationEnv({}, {});

    const redisBlock = extractServiceBlock(composeYaml, "redis");
    expect(redisBlock).toContain("image: redis:");
    expect(redisBlock).toContain("6379:6379");
    expect(redisBlock).toContain("redis-cli");
    expect(redisBlock).toContain("ping");

    const s3Block = extractServiceBlock(composeYaml, "s3");
    expect(s3Block).toContain("image: rustfs/rustfs");
    expect(s3Block).toContain("9000:9000");
    expect(s3Block).toContain("9001:9001");
    expect(s3Block).toContain("RUSTFS_ADDRESS");
    expect(s3Block).toContain("RUSTFS_CONSOLE_ENABLE");
    expect(s3Block).toContain(`RUSTFS_ACCESS_KEY: \${S3_ACCESS_KEY_ID:-${env.S3_ACCESS_KEY_ID}}`);
    expect(s3Block).toContain(`RUSTFS_SECRET_KEY: \${S3_SECRET_ACCESS_KEY:-${env.S3_SECRET_ACCESS_KEY}}`);
    expect(s3Block).toContain("/health");

    const s3InitBlock = extractServiceBlock(composeYaml, "s3-init");
    expect(s3InitBlock).toContain("image: amazon/aws-cli");
    expect(s3InitBlock).toContain("condition: service_healthy");
    expect(s3InitBlock).toMatch(/restart:\s+"?no"?/);
    expect(s3InitBlock).toContain(`S3_BUCKET: \${S3_BUCKET:-${env.S3_BUCKET}}`);
    expect(s3InitBlock).toContain("http://s3:9000");
    expect(s3InitBlock).toContain("head-bucket");
    expect(s3InitBlock).toContain("s3 mb");
  });

  it("defines migrate, api, and worker over shared db_data:/data and valid production env defaults", () => {
    const composeYaml = readFileSync(path.join(REPO_ROOT, "docker-compose.yml"), "utf8");

    expect(composeYaml).toContain("NODE_ENV: production");
    expect(composeYaml).toContain("DATABASE_URL: file:/data/app.db");
    expect(composeYaml).toContain("REDIS_URL: redis://redis:6379");
    expect(composeYaml).toContain("S3_ENDPOINT: http://s3:9000");
    expect(composeYaml).toContain(`S3_PUBLIC_ENDPOINT: \${S3_PUBLIC_ENDPOINT:-http://localhost:9000}`);
    expect(composeYaml).toContain("S3_FORCE_PATH_STYLE: \"true\"");
    expect(composeYaml).not.toMatch(/^\s*METRICS_TOKEN:/m);

    const secretFallbackMatch = composeYaml.match(/BETTER_AUTH_SECRET:\s*\$\{BETTER_AUTH_SECRET:-([^}]+)\}/);
    expect(secretFallbackMatch?.[1]).toBeDefined();
    expect(secretFallbackMatch![1].length).toBeGreaterThanOrEqual(32);

    const parsedProdEnv = parseEnv({
      NODE_ENV: "production",
      PORT: "9999",
      DATABASE_URL: "file:/data/app.db",
      REDIS_URL: "redis://redis:6379",
      BETTER_AUTH_SECRET: secretFallbackMatch![1],
      BETTER_AUTH_URL: "http://localhost:9999",
      STORAGE_DRIVER: "s3",
      S3_BUCKET: "app-uploads",
      S3_REGION: "us-east-1",
      S3_ENDPOINT: "http://s3:9000",
      S3_PUBLIC_ENDPOINT: "http://localhost:9000",
      S3_ACCESS_KEY_ID: "rustfsadmin",
      S3_SECRET_ACCESS_KEY: "rustfsadmin",
      S3_FORCE_PATH_STYLE: "true",
    });
    expect(parsedProdEnv.NODE_ENV).toBe("production");
    expect(parsedProdEnv.STORAGE_DRIVER).toBe("s3");
    expect(parsedProdEnv.METRICS_TOKEN).toBeUndefined();

    const migrateBlock = extractServiceBlock(composeYaml, "migrate");
    expect(migrateBlock).toContain("dist/src/infra/db/migrate.js");
    expect(migrateBlock).toMatch(/restart:\s+"?no"?/);
    expect(migrateBlock).toContain("db_data:/data");

    const apiBlock = extractServiceBlock(composeYaml, "api");
    expect(apiBlock).toContain("9999:9999");
    expect(apiBlock).toContain("db_data:/data");
    expect(apiBlock).toContain("stop_grace_period: 15s");
    expect(apiBlock).toContain("http://127.0.0.1:9999/health");
    expect(apiBlock).toContain("migrate:");
    expect(apiBlock).toContain("s3-init:");
    expect(apiBlock).toContain("service_completed_successfully");
    expect(apiBlock).toContain("redis:");
    expect(apiBlock).toContain("service_healthy");

    const workerBlock = extractServiceBlock(composeYaml, "worker");
    expect(workerBlock).toContain("dist/src/worker.js");
    expect(workerBlock).toContain("WORKER_METRICS_PORT: \"9091\"");
    expect(workerBlock).toContain("db_data:/data");
    expect(workerBlock).toContain("stop_grace_period: 15s");
    expect(workerBlock).toContain("http://127.0.0.1:9091/health");
    expect(workerBlock).toContain("migrate:");
    expect(workerBlock).toContain("s3-init:");
    expect(workerBlock).toContain("service_completed_successfully");
    expect(workerBlock).toContain("redis:");
    expect(workerBlock).toContain("service_healthy");

    expect(composeYaml).toMatch(/^ {2}db_data:$/m);
  });

  it("configures observability profile with Prometheus scraping api:9999 and worker:9091 and Grafana datasource", () => {
    const composeYaml = readFileSync(path.join(REPO_ROOT, "docker-compose.yml"), "utf8");

    const prometheusBlock = extractServiceBlock(composeYaml, "prometheus");
    expect(prometheusBlock).toContain("image: prom/prometheus");
    expect(prometheusBlock).toContain("observability");
    expect(prometheusBlock).toContain("./docker/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro");

    const grafanaBlock = extractServiceBlock(composeYaml, "grafana");
    expect(grafanaBlock).toContain("image: grafana/grafana");
    expect(grafanaBlock).toContain("observability");
    expect(grafanaBlock).toContain("./docker/grafana/provisioning:/etc/grafana/provisioning:ro");

    const prometheusConfig = readFileSync(
      path.join(REPO_ROOT, "docker/prometheus/prometheus.yml"),
      "utf8",
    );
    expect(prometheusConfig).toContain("api:9999");
    expect(prometheusConfig).toContain("worker:9091");
    expect(prometheusConfig).toContain("metrics_path: /metrics");

    const grafanaDatasource = readFileSync(
      path.join(REPO_ROOT, "docker/grafana/provisioning/datasources/prometheus.yml"),
      "utf8",
    );
    expect(grafanaDatasource).toContain("type: prometheus");
    expect(grafanaDatasource).toContain("http://prometheus:9090");
  });
});
