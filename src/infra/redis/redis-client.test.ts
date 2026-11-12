import { createServer } from "node:net";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { createLogger } from "@/core/logger";
import { parseEnv } from "@/env";
import { createRedisClient, defaultRedisRetryStrategy } from "@/infra/redis/client";

async function getClosedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close(() => reject(new Error("Expected numeric port")));
        return;
      }
      const { port } = addr;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(port);
      });
    });
  });
}

function createLogCollector() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString("utf8"));
      callback();
    },
  });
  return {
    stream,
    entries: () => lines
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("redis client factory", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("computes bounded exponential reconnect backoff", () => {
    expect(defaultRedisRetryStrategy(1)).toBe(100);
    expect(defaultRedisRetryStrategy(2)).toBe(200);
    expect(defaultRedisRetryStrategy(3)).toBe(400);
    expect(defaultRedisRetryStrategy(4)).toBe(800);
    expect(defaultRedisRetryStrategy(10)).toBe(5000);
  });

  it("configures fail-fast API options, attaches error listener, rejects ping on unreachable Redis, and quits cleanly", async () => {
    const closedPort = await getClosedPort();
    const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "warn" });
    const logs = createLogCollector();
    const logger = createLogger(env, logs.stream);

    const handle = createRedisClient({
      url: `redis://127.0.0.1:${closedPort}`,
      logger,
      connectionName: "test-api",
    });
    cleanups.push(handle.quit);

    expect(handle.client.options.enableOfflineQueue).toBe(false);
    expect(handle.client.options.maxRetriesPerRequest).toBe(2);
    expect(handle.client.listenerCount("error")).toBeGreaterThanOrEqual(1);

    await expect(handle.ping()).rejects.toThrow();

    await handle.quit();
    // Idempotent second quit
    await handle.quit();

    const entries = logs.entries();
    expect(entries.some(entry => entry.level === 40 && String(entry.msg).includes("Redis"))).toBe(true);
  });
});
