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
    expect(() => parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: undefined,
    })).toThrow(EnvValidationError);

    expect(() => parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "libsql://my-db.turso.io",
      DATABASE_AUTH_TOKEN: undefined,
    })).toThrow(EnvValidationError);

    expect(() => parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "https://my-db.turso.io",
      DATABASE_AUTH_TOKEN: "",
    })).toThrow(EnvValidationError);

    const remoteProd = parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "libsql://my-db.turso.io",
      DATABASE_AUTH_TOKEN: "secret-token",
    });
    expect(remoteProd.LOG_LEVEL).toBe("info");
    expect(remoteProd.CORS_ORIGINS).toEqual([]);
    expect(remoteProd.DATABASE_AUTH_TOKEN).toBe("secret-token");

    const fileProd = parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "file:/data/app.db",
      DATABASE_AUTH_TOKEN: undefined,
    });
    expect(fileProd.DATABASE_URL).toBe("file:/data/app.db");

    const localHttpProd = parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "http://sqld:8080",
      DATABASE_AUTH_TOKEN: undefined,
    });
    expect(localHttpProd.DATABASE_URL).toBe("http://sqld:8080");
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
});
