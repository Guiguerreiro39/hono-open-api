import { createServer } from "node:net";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createLogger } from "@/core/logger";
import { createTraceContext, runWithTraceContext } from "@/core/observability/trace";
import { defineJob } from "@/core/ports/queue";
import { parseEnv } from "@/env";
import { PromMetricsAdapter } from "@/infra/observability";
import { BullMQQueueAdapter, MemoryQueueAdapter } from "@/infra/queue";
import { defineQueueContract } from "../../../tests/contracts/queue.contract";

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

describe("memoryQueueAdapter", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.useRealTimers();
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  defineQueueContract("MemoryQueueAdapter", async () => {
    const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
    const logger = createLogger(env);
    const metrics = new PromMetricsAdapter({ collectDefaultMetrics: false });
    const queue = new MemoryQueueAdapter({
      mode: "buffered",
      logger,
      metrics,
    });

    return {
      queue,
      flush: () => queue.drain(),
      enqueueRaw: (name, payload, opts) => queue.enqueueRaw(name, payload, opts),
      cleanup: () => queue.close(),
    };
  });

  it("buffers jobs in test mode until drain(), exposes getJobs/getSchedules/clear, and deduplicates by jobId", async () => {
    const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
    const queue = new MemoryQueueAdapter({
      mode: "buffered",
      logger: createLogger(env),
    });
    cleanups.push(() => queue.close());

    const jobDef = defineJob({
      name: "demo.buffered",
      schema: z.object({ value: z.number() }),
    });

    const processed: number[] = [];
    queue.registerHandler(jobDef, async (data) => {
      processed.push(data.value);
    });

    const id1 = await queue.enqueue(jobDef, { value: 1 }, { jobId: "dedup-1" });
    const id2 = await queue.enqueue(jobDef, { value: 2 }, { jobId: "dedup-1" });
    expect(id1).toBe("dedup-1");
    expect(id2).toBe("dedup-1");
    expect(processed).toEqual([]);
    expect(queue.getJobs()).toHaveLength(1);
    expect(queue.getJobs()[0].status).toBe("waiting");

    await queue.drain();
    expect(processed).toEqual([1]);
    expect(queue.getJobs()[0].status).toBe("completed");

    await queue.upsertSchedule(
      "demo.cron",
      { pattern: "0 0 * * *", tz: "UTC" },
      { job: jobDef, data: { value: 99 } },
    );
    expect(queue.getSchedules()).toHaveLength(1);

    queue.clear();
    expect(queue.getJobs()).toHaveLength(0);
    expect(queue.getSchedules()).toHaveLength(0);
  });

  it("auto-drains via queueMicrotask in auto mode without creating background timers", async () => {
    vi.useFakeTimers();
    const env = parseEnv({ NODE_ENV: "development", LOG_LEVEL: "silent" });
    const queue = new MemoryQueueAdapter({
      mode: "auto",
      logger: createLogger(env),
    });
    cleanups.push(() => queue.close());

    expect(vi.getTimerCount()).toBe(0);

    const jobDef = defineJob({
      name: "demo.auto",
      schema: z.object({ msg: z.string() }),
    });

    const seen: string[] = [];
    queue.registerHandler(jobDef, async (data) => {
      await Promise.resolve();
      seen.push(data.msg);
    });

    const enqueuePromise = queue.enqueue(jobDef, { msg: "microtask-ran" });
    expect(seen).toEqual([]);
    await enqueuePromise;
    expect(vi.getTimerCount()).toBe(0);

    // Flush scheduled microtask and async handler
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(seen).toEqual(["microtask-ran"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries transient failures up to attempts and stops immediately on UnrecoverableError", async () => {
    const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
    const metrics = new PromMetricsAdapter({ collectDefaultMetrics: false });
    const failedEvents: Array<{ jobName: string; attempt: number; unrecoverable: boolean }> = [];
    const queue = new MemoryQueueAdapter({
      mode: "buffered",
      logger: createLogger(env),
      metrics,
      onJobFailed: (event) => {
        failedEvents.push({
          jobName: event.jobName,
          attempt: event.attempt,
          unrecoverable: event.unrecoverable,
        });
      },
    });
    cleanups.push(() => queue.close());

    const retryJob = defineJob({
      name: "demo.retry",
      schema: z.object({ failTimes: z.number().int().nonnegative() }),
    });

    let calls = 0;
    queue.registerHandler(retryJob, async (data) => {
      calls += 1;
      if (calls <= data.failTimes) {
        throw new Error(`transient-${calls}`);
      }
    });

    await queue.enqueue(retryJob, { failTimes: 2 }, { jobId: "retry-ok", attempts: 3 });
    await queue.enqueueRaw("demo.retry", { failTimes: "bad-type" }, { jobId: "bad-payload", attempts: 3 });

    await queue.drain();

    const jobs = queue.getJobs();
    const retriedJob = jobs.find(j => j.id === "retry-ok");
    const badJob = jobs.find(j => j.id === "bad-payload");

    expect(retriedJob?.status).toBe("completed");
    expect(retriedJob?.attemptsMade).toBe(3);

    expect(badJob?.status).toBe("failed");
    expect(badJob?.attemptsMade).toBe(1);

    expect(failedEvents).toEqual([
      { jobName: "demo.retry", attempt: 1, unrecoverable: false },
      { jobName: "demo.retry", attempt: 2, unrecoverable: false },
      { jobName: "demo.retry", attempt: 1, unrecoverable: true },
    ]);

    const rendered = await metrics.render();
    expect(rendered.body).toContain("jobs_processed_total{name=\"demo.retry\",status=\"completed\"} 1");
    expect(rendered.body).toContain("jobs_processed_total{name=\"demo.retry\",status=\"failed\"} 3");
    expect(rendered.body).toContain("job_duration_seconds_count{name=\"demo.retry\",status=\"completed\"} 1");
  });

  it("propagates trace_id and span_id into Pino child logger and triggers onJobComplete", async () => {
    const logs = createLogCollector();
    const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "info" });
    const logger = createLogger(env, logs.stream);
    const metrics = new PromMetricsAdapter({ collectDefaultMetrics: false });
    const completedEvents: Array<{ jobId: string; jobName: string; traceId: string }> = [];

    const queue = new MemoryQueueAdapter({
      mode: "buffered",
      logger,
      metrics,
      onJobComplete: (event) => {
        completedEvents.push({
          jobId: event.jobId,
          jobName: event.jobName,
          traceId: event.traceId,
        });
      },
    });
    cleanups.push(() => queue.close());

    const tracedJob = defineJob({
      name: "demo.traced",
      schema: z.object({ action: z.string() }),
    });

    queue.registerHandler(tracedJob, async (data, ctx) => {
      ctx.logger.info({ action: data.action }, "Handled traced job");
    });

    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const parentTrace = createTraceContext(`00-${traceId}-00f067aa0ba902b7-01`);

    await runWithTraceContext(parentTrace, async () => {
      await queue.enqueue(tracedJob, { action: "sync" }, { jobId: "trace-job-1" });
    });

    await queue.drain();

    const entries = logs.entries();
    const jobLog = entries.find(e => e.msg === "Handled traced job");
    expect(jobLog).toMatchObject({
      jobId: "trace-job-1",
      jobName: "demo.traced",
      attempt: 1,
      trace_id: traceId,
    });
    expect(jobLog?.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(jobLog?.span_id).not.toBe(parentTrace.spanId);

    expect(completedEvents).toEqual([
      { jobId: "trace-job-1", jobName: "demo.traced", traceId },
    ]);
  });
});

describe("bullMQQueueAdapter unit safeguards", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("configures fail-fast producer, maxRetriesPerRequest: null worker, prefix, and validates enqueue inputs without Redis", async () => {
    const closedPort = await getClosedPort();
    const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
    const adapter = new BullMQQueueAdapter({
      redisUrl: `redis://127.0.0.1:${closedPort}`,
      prefix: "svc",
      logger: createLogger(env),
      worker: true,
      concurrency: 7,
    });
    cleanups.push(() => adapter.close());

    expect(adapter.queueName).toBe("jobs");
    expect(adapter.prefix).toBe("svc:bull");
    expect(adapter.producerClient.options.enableOfflineQueue).toBe(false);
    expect(adapter.workerClient?.options.maxRetriesPerRequest).toBeNull();
    expect(adapter.workerConcurrency).toBe(7);

    const jobDef = defineJob({
      name: "unit.check",
      schema: z.object({ count: z.number().int().positive() }),
    });

    await expect(
      adapter.enqueue(jobDef, { count: -1 }),
    ).rejects.toThrow();

    await expect(
      adapter.enqueue(jobDef, { count: 1 }, { jobId: "bad:id" }),
    ).rejects.toThrow(/:/);

    // Enqueue against unreachable Redis fails fast (enableOfflineQueue: false) rather than hanging
    await expect(
      adapter.enqueue(jobDef, { count: 1 }, { jobId: "valid-id" }),
    ).rejects.toThrow();

    await adapter.close();
  });
});
