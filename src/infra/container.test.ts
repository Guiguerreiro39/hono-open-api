import { describe, expect, it, vi } from "vitest";

import { parseEnv } from "@/env";
import { createContainer, executeCloseSteps } from "@/infra/container";

describe("createContainer lifecycle and teardown", () => {
  it("supports markShuttingDown without aborting shutdownSignal until abortShutdown or close", async () => {
    const env = parseEnv({ NODE_ENV: "test", DATABASE_URL: ":memory:", LOG_LEVEL: "silent" });
    const container = createContainer(env);

    expect(container.isShuttingDown?.()).toBe(false);
    expect(container.shutdownSignal?.aborted).toBe(false);

    container.markShuttingDown();
    expect(container.isShuttingDown?.()).toBe(true);
    expect(container.shutdownSignal?.aborted).toBe(false);

    container.abortShutdown();
    expect(container.isShuttingDown?.()).toBe(true);
    expect(container.shutdownSignal?.aborted).toBe(true);

    await container.close();
    expect(container.client.closed).toBe(true);
  });

  it("closes adapters in reverse-dependency order and isolates errors so DB still closes", async () => {
    const env = parseEnv({ NODE_ENV: "test", DATABASE_URL: ":memory:", LOG_LEVEL: "silent" });
    const container = createContainer(env);
    const order: string[] = [];

    const origQueueClose = container.queue.close.bind(container.queue);
    const origPubSubClose = container.pubsub.close.bind(container.pubsub);
    const origRateLimiterClose = container.rateLimiter.close.bind(container.rateLimiter);

    container.queue.close = async () => {
      order.push("queue");
      await origQueueClose();
      throw new Error("queue close failed");
    };
    container.pubsub.close = async () => {
      order.push("pubsub");
      await origPubSubClose();
      throw new Error("pubsub close failed");
    };
    container.rateLimiter.close = async () => {
      order.push("rateLimiter");
      await origRateLimiterClose();
      throw new Error("rateLimiter close failed");
    };

    await expect(container.close()).resolves.toBeUndefined();

    expect(order).toEqual(["queue", "pubsub", "rateLimiter"]);
    expect(container.client.closed).toBe(true);
    expect(container.isShuttingDown?.()).toBe(true);
    expect(container.shutdownSignal?.aborted).toBe(true);
  });

  it("is single-flight when close() is called concurrently", async () => {
    const env = parseEnv({ NODE_ENV: "test", DATABASE_URL: ":memory:", LOG_LEVEL: "silent" });
    const container = createContainer(env);
    let queueCloseCount = 0;

    const origQueueClose = container.queue.close.bind(container.queue);
    container.queue.close = async () => {
      queueCloseCount += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      await origQueueClose();
    };

    await Promise.all([container.close(), container.close(), container.close()]);

    expect(queueCloseCount).toBe(1);
    expect(container.client.closed).toBe(true);
  });

  it("isolates errors across every teardown step in executeCloseSteps", async () => {
    const order: string[] = [];
    const warnings: Array<{ step: string; err: unknown }> = [];
    const warn = vi.fn((obj: Record<string, unknown>) => {
      warnings.push({ step: String(obj.step), err: obj.err });
    });

    await executeCloseSteps(
      [
        {
          name: "queue",
          close: async () => {
            order.push("queue");
            throw new Error("queue boom");
          },
        },
        {
          name: "pubsub",
          close: async () => {
            order.push("pubsub");
            throw new Error("pubsub boom");
          },
        },
        {
          name: "rateLimiter",
          close: async () => {
            order.push("rateLimiter");
            throw new Error("rateLimiter boom");
          },
        },
        {
          name: "redis",
          close: async () => {
            order.push("redis");
            throw new Error("redis boom");
          },
        },
        {
          name: "storage",
          close: async () => {
            order.push("storage");
            throw new Error("storage boom");
          },
        },
        {
          name: "db",
          close: async () => {
            order.push("db");
            throw new Error("db boom");
          },
        },
      ],
      { warn },
    );

    expect(order).toEqual(["queue", "pubsub", "rateLimiter", "redis", "storage", "db"]);
    expect(warnings.map(w => w.step)).toEqual([
      "queue",
      "pubsub",
      "rateLimiter",
      "redis",
      "storage",
      "db",
    ]);
  });
});
