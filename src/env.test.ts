/* eslint-disable node/no-process-env */
import { describe, expect, it } from "vitest";

import { EnvValidationError, loadEnv, parseEnv } from "@/env";

describe("parseEnv", () => {
  it("applies safe test defaults without mutating process.env", () => {
    const beforeSnapshot = { ...process.env };

    const env = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: undefined,
      LOG_LEVEL: undefined,
      APP_NAME: undefined,
      CORS_ORIGINS: undefined,
    });

    expect(env.NODE_ENV).toBe("test");
    expect(env.APP_NAME).toBe("Hono OpenAPI Starter");
    expect(env.DATABASE_URL).toBe(":memory:");
    expect(env.LOG_LEVEL).toBe("silent");
    expect(env.PORT).toBe(9999);
    expect(env.CORS_ORIGINS).toEqual(["http://localhost:3000"]);
    expect(env.READINESS_TIMEOUT_MS).toBe(2000);
    expect(env.METRICS_ENABLED).toBe(true);
    expect(env.METRICS_TOKEN).toBeUndefined();
    expect(env.WORKER_METRICS_PORT).toBeUndefined();
    expect(env.WORKER_EMBEDDED).toBe(false);
    expect(env.WORKER_CONCURRENCY).toBe(5);
    expect(env.WORKER_SHUTDOWN_TIMEOUT_MS).toBe(10_000);
    expect(env.REDIS_URL).toBeUndefined();
    expect(env.CACHE_PREFIX).toBe("app");
    expect(env.TRUST_PROXY).toBe(false);
    expect(env.RATE_LIMIT_ENABLED).toBe(false);
    expect(env.BETTER_AUTH_SECRET).toBe("secret");
    expect(env.BETTER_AUTH_URL).toBe("http://localhost:9999");
    expect(env.STORAGE_DRIVER).toBe("memory");
    expect(env.STORAGE_LOCAL_DIR).toBe("./.storage");
    expect(env.STORAGE_MAX_FILE_SIZE_BYTES).toBe(10_485_760);
    expect(env.STORAGE_PRESIGN_MAX_FILE_SIZE_BYTES).toBe(104_857_600);
    expect(env.STORAGE_PRESIGN_EXPIRES_SECONDS).toBe(900);
    expect(env.STORAGE_SIGNING_SECRET).toBe("secret");
    expect(env.S3_REGION).toBe("us-east-1");
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
    expect(process.env).toEqual(beforeSnapshot);

    const defaultEnv = parseEnv();
    expect(defaultEnv.NODE_ENV).toBe("test");
    expect(defaultEnv.DATABASE_URL).toBe(":memory:");
    expect(defaultEnv.LOG_LEVEL).toBe("silent");
    expect(process.env).toEqual(beforeSnapshot);
  });

  it("parses and normalizes CORS_ORIGINS and rejects invalid origins", () => {
    const env = parseEnv({
      NODE_ENV: "development",
      CORS_ORIGINS: " http://localhost:3000/ , https://app.example.com:8443/path ",
    });

    expect(env.CORS_ORIGINS).toEqual([
      "http://localhost:3000",
      "https://app.example.com:8443",
    ]);
    expect(env.LOG_LEVEL).toBe("debug");
    expect(env.DATABASE_URL).toBe("file:dev.db");

    expect(() => parseEnv({
      NODE_ENV: "test",
      CORS_ORIGINS: "not-a-valid-origin",
    })).toThrow(EnvValidationError);
  });

  it("requires DATABASE_AUTH_TOKEN in production only for libsql:// and https:// URLs", () => {
    const validProdAuth = {
      BETTER_AUTH_SECRET: "a-very-long-and-secure-production-secret-32chars",
      BETTER_AUTH_URL: "https://api.example.com",
      REDIS_URL: "redis://localhost:6379",
      S3_BUCKET: "prod-uploads",
    };

    expect(() => parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: undefined,
      ...validProdAuth,
    })).toThrow(EnvValidationError);

    expect(() => parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "libsql://my-db.turso.io",
      DATABASE_AUTH_TOKEN: undefined,
      ...validProdAuth,
    })).toThrow(EnvValidationError);

    expect(() => parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "https://my-db.turso.io",
      DATABASE_AUTH_TOKEN: "",
      ...validProdAuth,
    })).toThrow(EnvValidationError);

    const remoteProd = parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "libsql://my-db.turso.io",
      DATABASE_AUTH_TOKEN: "secret-token",
      ...validProdAuth,
    });
    expect(remoteProd.LOG_LEVEL).toBe("info");
    expect(remoteProd.CORS_ORIGINS).toEqual([]);
    expect(remoteProd.DATABASE_AUTH_TOKEN).toBe("secret-token");

    const fileProd = parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "file:/data/app.db",
      DATABASE_AUTH_TOKEN: undefined,
      ...validProdAuth,
    });
    expect(fileProd.DATABASE_URL).toBe("file:/data/app.db");

    const localHttpProd = parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "http://sqld:8080",
      DATABASE_AUTH_TOKEN: undefined,
      ...validProdAuth,
    });
    expect(localHttpProd.DATABASE_URL).toBe("http://sqld:8080");
  });

  it("rejects weak BETTER_AUTH_SECRET and missing or invalid BETTER_AUTH_URL in production", () => {
    const baseProd = {
      NODE_ENV: "production" as const,
      DATABASE_URL: "file:/data/app.db",
      BETTER_AUTH_SECRET: "a-very-long-and-secure-production-secret-32chars",
      BETTER_AUTH_URL: "https://api.example.com",
      REDIS_URL: "redis://localhost:6379",
      S3_BUCKET: "prod-uploads",
    };

    expect(() => parseEnv({
      ...baseProd,
      BETTER_AUTH_SECRET: undefined,
    })).toThrow(EnvValidationError);

    expect(() => parseEnv({
      ...baseProd,
      BETTER_AUTH_SECRET: "secret",
    })).toThrow(EnvValidationError);

    expect(() => parseEnv({
      ...baseProd,
      BETTER_AUTH_SECRET: "short-secret-under-32-chars",
    })).toThrow(EnvValidationError);

    expect(() => parseEnv({
      ...baseProd,
      BETTER_AUTH_URL: undefined,
    })).toThrow(EnvValidationError);

    expect(() => parseEnv({
      ...baseProd,
      BETTER_AUTH_URL: "ftp://api.example.com",
    })).toThrow(EnvValidationError);

    const parsed = parseEnv(baseProd);
    expect(parsed.BETTER_AUTH_SECRET).toBe(baseProd.BETTER_AUTH_SECRET);
    expect(parsed.BETTER_AUTH_URL).toBe(baseProd.BETTER_AUTH_URL);
  });

  it("writes invalid startup errors to stderr and exits cleanly", () => {
    const stderrChunks: string[] = [];
    let exitCode: number | undefined;

    expect(() => loadEnv({
      overrides: {
        NODE_ENV: "production",
        DATABASE_URL: "libsql://my-db.turso.io",
        DATABASE_AUTH_TOKEN: undefined,
      },
      writeStderr: chunk => stderrChunks.push(chunk),
      exit: (code) => {
        exitCode = code;
        throw new Error(`EXIT_${code}`);
      },
    })).toThrow("EXIT_1");

    expect(exitCode).toBe(1);
    expect(stderrChunks.join("")).toContain("DATABASE_AUTH_TOKEN");
  });

  it("auto-selects STORAGE_DRIVER by environment and enforces S3_BUCKET when s3", () => {
    const devLocal = parseEnv({
      NODE_ENV: "development",
      S3_BUCKET: undefined,
      STORAGE_DRIVER: undefined,
    });
    expect(devLocal.STORAGE_DRIVER).toBe("local");

    const devS3 = parseEnv({
      NODE_ENV: "development",
      S3_BUCKET: "dev-bucket",
      STORAGE_DRIVER: undefined,
    });
    expect(devS3.STORAGE_DRIVER).toBe("s3");
    expect(devS3.S3_BUCKET).toBe("dev-bucket");

    expect(() => parseEnv({
      NODE_ENV: "test",
      STORAGE_DRIVER: "s3",
      S3_BUCKET: undefined,
    })).toThrow(EnvValidationError);

    expect(() => parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "file:/data/app.db",
      REDIS_URL: "redis://localhost:6379",
      BETTER_AUTH_SECRET: "a-very-long-and-secure-production-secret-32chars",
      BETTER_AUTH_URL: "https://api.example.com",
      S3_BUCKET: undefined,
      STORAGE_DRIVER: undefined,
    })).toThrow(EnvValidationError);

    const prodLocal = parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "file:/data/app.db",
      REDIS_URL: "redis://localhost:6379",
      BETTER_AUTH_SECRET: "a-very-long-and-secure-production-secret-32chars",
      BETTER_AUTH_URL: "https://api.example.com",
      STORAGE_DRIVER: "local",
      S3_BUCKET: undefined,
    });
    expect(prodLocal.STORAGE_DRIVER).toBe("local");
  });

  it("validates S3 credentials as an optional pair, parses S3_FORCE_PATH_STYLE booleans, and falls back STORAGE_SIGNING_SECRET", () => {
    const iamEnv = parseEnv({
      NODE_ENV: "test",
      STORAGE_DRIVER: "s3",
      S3_BUCKET: "iam-bucket",
      S3_ACCESS_KEY_ID: undefined,
      S3_SECRET_ACCESS_KEY: undefined,
    });
    expect(iamEnv.S3_ACCESS_KEY_ID).toBeUndefined();
    expect(iamEnv.S3_SECRET_ACCESS_KEY).toBeUndefined();
    expect(iamEnv.STORAGE_SIGNING_SECRET).toBe("secret");

    expect(() => parseEnv({
      NODE_ENV: "test",
      STORAGE_DRIVER: "s3",
      S3_BUCKET: "iam-bucket",
      S3_ACCESS_KEY_ID: "only-access-key",
      S3_SECRET_ACCESS_KEY: undefined,
    })).toThrow(EnvValidationError);

    expect(() => parseEnv({
      NODE_ENV: "test",
      STORAGE_DRIVER: "s3",
      S3_BUCKET: "iam-bucket",
      S3_ACCESS_KEY_ID: undefined,
      S3_SECRET_ACCESS_KEY: "only-secret-key",
    })).toThrow(EnvValidationError);

    const explicitSigning = parseEnv({
      NODE_ENV: "test",
      STORAGE_SIGNING_SECRET: "dedicated-storage-secret",
      S3_FORCE_PATH_STYLE: "false",
    });
    expect(explicitSigning.STORAGE_SIGNING_SECRET).toBe("dedicated-storage-secret");
    expect(explicitSigning.S3_FORCE_PATH_STYLE).toBe(false);

    const pathStyleTrue = parseEnv({
      NODE_ENV: "test",
      S3_FORCE_PATH_STYLE: "true",
      S3_ENDPOINT: "http://localhost:9000",
      S3_PUBLIC_ENDPOINT: "https://files.example.com",
    });
    expect(pathStyleTrue.S3_FORCE_PATH_STYLE).toBe(true);
    expect(pathStyleTrue.S3_ENDPOINT).toBe("http://localhost:9000");
    expect(pathStyleTrue.S3_PUBLIC_ENDPOINT).toBe("https://files.example.com");

    expect(() => parseEnv({
      NODE_ENV: "test",
      S3_FORCE_PATH_STYLE: "not-a-boolean",
    })).toThrow(EnvValidationError);

    expect(() => parseEnv({
      NODE_ENV: "test",
      S3_ENDPOINT: "ftp://invalid-scheme:9000",
    })).toThrow(EnvValidationError);

    expect(() => parseEnv({
      NODE_ENV: "test",
      S3_PUBLIC_ENDPOINT: "not-a-url",
    })).toThrow(EnvValidationError);
  });

  it("parses METRICS_ENABLED booleans/strings, METRICS_TOKEN, and WORKER_METRICS_PORT cleanly", () => {
    expect(parseEnv({ NODE_ENV: "test", METRICS_ENABLED: "false" }).METRICS_ENABLED).toBe(false);
    expect(parseEnv({ NODE_ENV: "test", METRICS_ENABLED: "FALSE" }).METRICS_ENABLED).toBe(false);
    expect(parseEnv({ NODE_ENV: "test", METRICS_ENABLED: "0" }).METRICS_ENABLED).toBe(false);
    expect(parseEnv({ NODE_ENV: "test", METRICS_ENABLED: false }).METRICS_ENABLED).toBe(false);
    expect(parseEnv({ NODE_ENV: "test", METRICS_ENABLED: "true" }).METRICS_ENABLED).toBe(true);
    expect(parseEnv({ NODE_ENV: "test", METRICS_ENABLED: "1" }).METRICS_ENABLED).toBe(true);
    expect(parseEnv({ NODE_ENV: "test", METRICS_ENABLED: "" }).METRICS_ENABLED).toBe(true);

    expect(() => parseEnv({ NODE_ENV: "test", METRICS_ENABLED: "not-a-bool" })).toThrow(EnvValidationError);

    const configured = parseEnv({
      NODE_ENV: "test",
      METRICS_TOKEN: "scrape-secret",
      WORKER_METRICS_PORT: "9091",
    });
    expect(configured.METRICS_TOKEN).toBe("scrape-secret");
    expect(configured.WORKER_METRICS_PORT).toBe(9091);

    expect(parseEnv({ NODE_ENV: "test", METRICS_TOKEN: "   ", WORKER_METRICS_PORT: "" })).toMatchObject({
      METRICS_TOKEN: undefined,
      WORKER_METRICS_PORT: undefined,
    });

    expect(() => parseEnv({ NODE_ENV: "test", WORKER_METRICS_PORT: "70000" })).toThrow(EnvValidationError);
    expect(() => parseEnv({ NODE_ENV: "test", WORKER_METRICS_PORT: "-1" })).toThrow(EnvValidationError);
    expect(() => parseEnv({ NODE_ENV: "test", WORKER_METRICS_PORT: "abc" })).toThrow(EnvValidationError);
  });

  it("validates REDIS_URL (required in production), CACHE_PREFIX, TRUST_PROXY, and RATE_LIMIT_ENABLED", () => {
    const prodBase = {
      NODE_ENV: "production" as const,
      DATABASE_URL: "file:/data/app.db",
      BETTER_AUTH_SECRET: "a-very-long-and-secure-production-secret-32chars",
      BETTER_AUTH_URL: "https://api.example.com",
      S3_BUCKET: "prod-uploads",
    };

    expect(() => parseEnv(prodBase)).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...prodBase, REDIS_URL: "   " })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...prodBase, REDIS_URL: "http://localhost:6379" })).toThrow(EnvValidationError);
    expect(() => parseEnv({ ...prodBase, REDIS_URL: "redis://" })).toThrow(EnvValidationError);

    const redisProd = parseEnv({ ...prodBase, REDIS_URL: "redis://redis:6379/0" });
    expect(redisProd.REDIS_URL).toBe("redis://redis:6379/0");
    expect(redisProd.RATE_LIMIT_ENABLED).toBe(true);
    expect(redisProd.TRUST_PROXY).toBe(false);
    expect(redisProd.CACHE_PREFIX).toBe("app");

    const tlsRedisProd = parseEnv({
      ...prodBase,
      REDIS_URL: "rediss://default:secret@cache.example.com:6380",
      CACHE_PREFIX: "prod-api",
      TRUST_PROXY: "true",
      RATE_LIMIT_ENABLED: "false",
    });
    expect(tlsRedisProd.REDIS_URL).toBe("rediss://default:secret@cache.example.com:6380");
    expect(tlsRedisProd.CACHE_PREFIX).toBe("prod-api");
    expect(tlsRedisProd.TRUST_PROXY).toBe(true);
    expect(tlsRedisProd.RATE_LIMIT_ENABLED).toBe(false);

    const devDefaults = parseEnv({ NODE_ENV: "development" });
    expect(devDefaults.REDIS_URL).toBeUndefined();
    expect(devDefaults.RATE_LIMIT_ENABLED).toBe(true);

    expect(parseEnv({ NODE_ENV: "test", REDIS_URL: "" }).REDIS_URL).toBeUndefined();
    expect(parseEnv({ NODE_ENV: "test", RATE_LIMIT_ENABLED: "true", TRUST_PROXY: "1" })).toMatchObject({
      RATE_LIMIT_ENABLED: true,
      TRUST_PROXY: true,
    });
    expect(parseEnv({ NODE_ENV: "test", RATE_LIMIT_ENABLED: "" }).RATE_LIMIT_ENABLED).toBe(false);
    expect(() => parseEnv({ NODE_ENV: "test", TRUST_PROXY: "yes" })).toThrow(EnvValidationError);
    expect(() => parseEnv({ NODE_ENV: "test", RATE_LIMIT_ENABLED: "maybe" })).toThrow(EnvValidationError);
  });

  it("parses WORKER_EMBEDDED, WORKER_CONCURRENCY, and WORKER_SHUTDOWN_TIMEOUT_MS with validation", () => {
    const defaults = parseEnv({ NODE_ENV: "test" });
    expect(defaults.WORKER_EMBEDDED).toBe(false);
    expect(defaults.WORKER_CONCURRENCY).toBe(5);
    expect(defaults.WORKER_SHUTDOWN_TIMEOUT_MS).toBe(10_000);

    const configured = parseEnv({
      NODE_ENV: "development",
      WORKER_EMBEDDED: "true",
      WORKER_CONCURRENCY: "12",
      WORKER_SHUTDOWN_TIMEOUT_MS: "25000",
    });
    expect(configured.WORKER_EMBEDDED).toBe(true);
    expect(configured.WORKER_CONCURRENCY).toBe(12);
    expect(configured.WORKER_SHUTDOWN_TIMEOUT_MS).toBe(25_000);

    expect(parseEnv({ NODE_ENV: "test", WORKER_EMBEDDED: "1" }).WORKER_EMBEDDED).toBe(true);
    expect(parseEnv({ NODE_ENV: "test", WORKER_EMBEDDED: "0" }).WORKER_EMBEDDED).toBe(false);
    expect(parseEnv({ NODE_ENV: "test", WORKER_EMBEDDED: "" }).WORKER_EMBEDDED).toBe(false);

    expect(() => parseEnv({ NODE_ENV: "test", WORKER_EMBEDDED: "yes" })).toThrow(EnvValidationError);
    expect(() => parseEnv({ NODE_ENV: "test", WORKER_CONCURRENCY: "0" })).toThrow(EnvValidationError);
    expect(() => parseEnv({ NODE_ENV: "test", WORKER_CONCURRENCY: "-2" })).toThrow(EnvValidationError);
    expect(() => parseEnv({ NODE_ENV: "test", WORKER_CONCURRENCY: "1.5" })).toThrow(EnvValidationError);
    expect(() => parseEnv({ NODE_ENV: "test", WORKER_SHUTDOWN_TIMEOUT_MS: "0" })).toThrow(EnvValidationError);
    expect(() => parseEnv({ NODE_ENV: "test", WORKER_SHUTDOWN_TIMEOUT_MS: "abc" })).toThrow(EnvValidationError);
  });

  it("parses MAX_SSE_CONNECTIONS with default 1000 and allows 0 (unlimited) while rejecting negative or non-integer values", () => {
    expect(parseEnv({ NODE_ENV: "test" }).MAX_SSE_CONNECTIONS).toBe(1000);
    expect(parseEnv({ NODE_ENV: "test", MAX_SSE_CONNECTIONS: "" }).MAX_SSE_CONNECTIONS).toBe(1000);
    expect(parseEnv({ NODE_ENV: "test", MAX_SSE_CONNECTIONS: "0" }).MAX_SSE_CONNECTIONS).toBe(0);
    expect(parseEnv({ NODE_ENV: "test", MAX_SSE_CONNECTIONS: 0 }).MAX_SSE_CONNECTIONS).toBe(0);
    expect(parseEnv({ NODE_ENV: "test", MAX_SSE_CONNECTIONS: "250" }).MAX_SSE_CONNECTIONS).toBe(250);

    expect(() => parseEnv({ NODE_ENV: "test", MAX_SSE_CONNECTIONS: "-1" })).toThrow(EnvValidationError);
    expect(() => parseEnv({ NODE_ENV: "test", MAX_SSE_CONNECTIONS: "1.5" })).toThrow(EnvValidationError);
    expect(() => parseEnv({ NODE_ENV: "test", MAX_SSE_CONNECTIONS: "abc" })).toThrow(EnvValidationError);
  });

  it("parses SHUTDOWN_TIMEOUT_MS and SHUTDOWN_DRAIN_DELAY_MS with validation", () => {
    const defaults = parseEnv({ NODE_ENV: "test" });
    expect(defaults.SHUTDOWN_TIMEOUT_MS).toBe(10_000);
    expect(defaults.SHUTDOWN_DRAIN_DELAY_MS).toBe(0);

    const configured = parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "file:prod.db",
      BETTER_AUTH_SECRET: "a-very-strong-secret-with-more-than-32-chars",
      BETTER_AUTH_URL: "https://api.example.com",
      REDIS_URL: "redis://redis:6379",
      S3_BUCKET: "prod-uploads",
      SHUTDOWN_TIMEOUT_MS: "15000",
      SHUTDOWN_DRAIN_DELAY_MS: "2500",
    });
    expect(configured.SHUTDOWN_TIMEOUT_MS).toBe(15_000);
    expect(configured.SHUTDOWN_DRAIN_DELAY_MS).toBe(2500);

    expect(parseEnv({ NODE_ENV: "test", SHUTDOWN_TIMEOUT_MS: "" }).SHUTDOWN_TIMEOUT_MS).toBe(10_000);
    expect(parseEnv({ NODE_ENV: "test", SHUTDOWN_DRAIN_DELAY_MS: "" }).SHUTDOWN_DRAIN_DELAY_MS).toBe(0);
    expect(parseEnv({ NODE_ENV: "test", SHUTDOWN_DRAIN_DELAY_MS: "0" }).SHUTDOWN_DRAIN_DELAY_MS).toBe(0);

    expect(() => parseEnv({ NODE_ENV: "test", SHUTDOWN_TIMEOUT_MS: "0" })).toThrow(EnvValidationError);
    expect(() => parseEnv({ NODE_ENV: "test", SHUTDOWN_TIMEOUT_MS: "-1" })).toThrow(EnvValidationError);
    expect(() => parseEnv({ NODE_ENV: "test", SHUTDOWN_TIMEOUT_MS: "abc" })).toThrow(EnvValidationError);
    expect(() => parseEnv({ NODE_ENV: "test", SHUTDOWN_DRAIN_DELAY_MS: "-1" })).toThrow(EnvValidationError);
    expect(() => parseEnv({ NODE_ENV: "test", SHUTDOWN_DRAIN_DELAY_MS: "1.5" })).toThrow(EnvValidationError);
    expect(() => parseEnv({ NODE_ENV: "test", SHUTDOWN_DRAIN_DELAY_MS: "abc" })).toThrow(EnvValidationError);
  });
});
