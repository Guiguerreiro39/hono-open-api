import { Writable } from "node:stream";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createLogger } from "@/core/logger";
import { createTraceContext, runWithTraceContext } from "@/core/observability/trace";
import { defineJob } from "@/core/ports/queue";
import { parseEnv } from "@/env";
import { PromMetricsAdapter } from "@/infra/observability";
import { BullMQQueueAdapter } from "@/infra/queue";
import { createRedisClient } from "@/infra/redis";
import { defineQueueContract } from "../contracts/queue.contract";
import { getIntegrationEnv } from "./env";

const integrationEnv = getIntegrationEnv();
const REDIS_URL = integrationEnv.REDIS_URL;

async function assertRedisReachable(): Promise<void> {
  const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", REDIS_URL });
  const handle = createRedisClient({
    url: REDIS_URL,
    logger: createLogger(env),
    connectionName: "queue-integration-preflight",
    connectTimeoutMs: 2000,
  });

  try {
    await handle.ping();
  }
  catch (err) {
    throw new Error(
      `Queue integration test requires a reachable Redis server at ${REDIS_URL}. Start it with "docker compose up -d --wait redis".`,
      { cause: err },
    );
  }
  finally {
    await handle.quit();
  }
}

async function deletePrefixKeys(prefix: string): Promise<void> {
  const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", REDIS_URL });
  const handle = createRedisClient({
    url: REDIS_URL,
    logger: createLogger(env),
    connectionName: `${prefix}-cleanup`,
  });
  try {
    await handle.ping();
    const keys = await handle.client.keys(`${prefix}:*`);
    if (keys.length > 0) {
      await handle.client.del(...keys);
    }
  }
  finally {
    await handle.quit();
  }
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for BullMQ job`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

beforeAll(async () => {
  await assertRedisReachable();
});

defineQueueContract("BullMQQueueAdapter", async () => {
  const prefix = `int-q-${crypto.randomUUID().slice(0, 8)}`;
  const env = parseEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    REDIS_URL,
    CACHE_PREFIX: prefix,
  });
  const logger = createLogger(env);
  const metrics = new PromMetricsAdapter({ collectDefaultMetrics: false });

  const adapter = new BullMQQueueAdapter({
    redisUrl: REDIS_URL,
    prefix,
    logger,
    metrics,
    worker: true,
    concurrency: 2,
  });

  return {
    queue: adapter,
    flush: async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    },
    enqueueRaw: async (name, payload, opts) => {
      const job = await adapter.getRawQueue().add(name, payload, {
        ...(opts?.jobId !== undefined ? { jobId: opts.jobId } : {}),
        ...(opts?.attempts !== undefined ? { attempts: opts.attempts } : {}),
      });
      return job.id ?? "";
    },
    cleanup: async () => {
      await adapter.close();
      await deletePrefixKeys(prefix);
    },
  };
});

describe("bullMQQueueAdapter integration specifics", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("moves schema-mismatched execution payloads directly to failed with UnrecoverableError and propagates traces/metrics", async () => {
    const prefix = `int-qspec-${crypto.randomUUID().slice(0, 8)}`;
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString("utf8"));
        callback();
      },
    });
    const env = parseEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "info",
      REDIS_URL,
      CACHE_PREFIX: prefix,
    });
    const logger = createLogger(env, sink);
    const metrics = new PromMetricsAdapter({ collectDefaultMetrics: false });

    const completed: string[] = [];
    const failed: Array<{ jobId: string; unrecoverable: boolean }> = [];

    const adapter = new BullMQQueueAdapter({
      redisUrl: REDIS_URL,
      prefix,
      logger,
      metrics,
      worker: true,
      onJobComplete: (event) => {
        completed.push(event.jobId);
      },
      onJobFailed: (event) => {
        failed.push({ jobId: event.jobId, unrecoverable: event.unrecoverable });
      },
    });

    cleanups.push(async () => {
      await adapter.close();
      await deletePrefixKeys(prefix);
    });

    const jobDef = defineJob({
      name: "int.audit",
      schema: z.object({ taskId: z.uuid() }),
    });

    adapter.registerHandler(jobDef, async (data, ctx) => {
      ctx.logger.info({ taskId: data.taskId }, "Processed integration job");
    });

    // 1. Raw invalid payload fails immediately on attempt 1 via UnrecoverableError
    const badJob = await adapter.getRawQueue().add(
      "int.audit",
      { taskId: "not-a-uuid" },
      { attempts: 3 },
    );

    await waitUntil(async () => {
      const state = await badJob.getState();
      return state === "failed";
    });

    const refreshedBad = await adapter.getRawQueue().getJob(badJob.id!);
    expect(refreshedBad?.attemptsMade).toBe(1);
    expect(failed).toContainEqual({ jobId: badJob.id!, unrecoverable: true });

    // 2. Valid job propagates trace_id into Pino child logger and records metrics
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const traceCtx = createTraceContext(`00-${traceId}-00f067aa0ba902b7-01`);
    const taskId = crypto.randomUUID();
    const validId = await runWithTraceContext(traceCtx, () =>
      adapter.enqueue(jobDef, { taskId }, { jobId: `valid-${taskId}` }));

    await waitUntil(() => completed.includes(validId));

    const entries = lines
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const jobLog = entries.find(e => e.msg === "Processed integration job");
    expect(jobLog).toMatchObject({
      jobId: validId,
      jobName: "int.audit",
      attempt: 1,
      trace_id: traceId,
    });
    expect(jobLog?.span_id).toMatch(/^[0-9a-f]{16}$/);

    const rendered = await metrics.render();
    expect(rendered.body).toContain("jobs_processed_total{name=\"int.audit\",status=\"completed\"} 1");
    expect(rendered.body).toContain("jobs_processed_total{name=\"int.audit\",status=\"failed\"} 1");
  });
});
