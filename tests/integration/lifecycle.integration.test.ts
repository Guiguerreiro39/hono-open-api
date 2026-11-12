import type { Buffer } from "node:buffer";
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import { createLogger } from "@/core/logger";
import { defineJob } from "@/core/ports/queue";
import { parseEnv } from "@/env";
import { BullMQQueueAdapter } from "@/infra/queue";
import { createRedisClient } from "@/infra/redis";
import { tasksAuditJob } from "@/modules/tasks/tasks.jobs";
import { getIntegrationEnv } from "./env";

const integrationEnv = getIntegrationEnv();
const REDIS_URL = integrationEnv.REDIS_URL;

const slowJobDef = defineJob({
  name: "lifecycle.slow",
  schema: z.object({ delayMs: z.number().int().positive(), marker: z.string().min(1) }),
});

async function assertRedisReachable(): Promise<void> {
  const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", REDIS_URL });
  const handle = createRedisClient({
    url: REDIS_URL,
    logger: createLogger(env),
    connectionName: "lifecycle-integration-preflight",
    connectTimeoutMs: 2000,
  });

  try {
    await handle.ping();
  }
  catch (err) {
    throw new Error(
      `Lifecycle integration test requires a reachable Redis server at ${REDIS_URL}. Start it with "docker compose up -d --wait redis".`,
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

function waitForOutput(
  child: ChildProcess,
  needle: string,
  timeoutMs = 10_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for '${needle}'. Output:\n${buffer}`));
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes(needle)) {
        cleanup();
        resolve(buffer);
      }
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Child exited unexpectedly (code=${code}, signal=${signal}) before '${needle}'. Output:\n${buffer}`));
    };

    function cleanup() {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
    }

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });
}

function waitForExit(
  child: ChildProcess,
  timeoutMs = 10_000,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;

    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };

    timer = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for child process to exit`));
    }, timeoutMs);

    child.on("exit", onExit);
  });
}

beforeAll(async () => {
  await assertRedisReachable();
});

describe("process lifecycle child-process SIGTERM BullMQ integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("drains src/worker.ts cleanly on SIGTERM and exits 0", async () => {
    const prefix = `int-life-cli-${crypto.randomUUID().slice(0, 8)}`;
    const tsxBin = path.resolve(process.cwd(), "node_modules/.bin/tsx");
    const env = parseEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      REDIS_URL,
      CACHE_PREFIX: prefix,
    });

    const producer = new BullMQQueueAdapter({
      redisUrl: REDIS_URL,
      prefix,
      logger: createLogger(env),
      worker: false,
    });

    const child = spawn(tsxBin, ["src/worker.ts"], {
      cwd: process.cwd(),
      env: {
        // eslint-disable-next-line node/no-process-env
        ...process.env,
        NODE_ENV: "test",
        DATABASE_URL: ":memory:",
        LOG_LEVEL: "info",
        REDIS_URL,
        CACHE_PREFIX: prefix,
        WORKER_METRICS_PORT: "0",
        SHUTDOWN_TIMEOUT_MS: "5000",
        WORKER_SHUTDOWN_TIMEOUT_MS: "5000",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await producer.close();
      await deletePrefixKeys(prefix);
    });

    await waitForOutput(child, "Worker started");

    const jobId = await producer.enqueue(tasksAuditJob, {
      action: "created",
      taskId: crypto.randomUUID(),
      userId: "user-1",
      actorId: "user-1",
      taskName: "Lifecycle SIGTERM CLI test",
      done: false,
    });

    // Wait briefly for job pickup, then signal graceful shutdown
    await new Promise(resolve => setTimeout(resolve, 150));
    child.kill("SIGTERM");

    const exitResult = await waitForExit(child);
    expect(exitResult).toEqual({ code: 0, signal: null });

    const job = await producer.getRawQueue().getJob(jobId);
    expect(await job?.getState()).toBe("completed");
  });

  it("finishes an in-flight BullMQ job before exiting 0 on SIGTERM", async () => {
    const prefix = `int-life-job-${crypto.randomUUID().slice(0, 8)}`;
    const tsxBin = path.resolve(process.cwd(), "node_modules/.bin/tsx");
    const env = parseEnv({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      REDIS_URL,
      CACHE_PREFIX: prefix,
    });

    const producer = new BullMQQueueAdapter({
      redisUrl: REDIS_URL,
      prefix,
      logger: createLogger(env),
      worker: false,
    });

    const childScript = `
      import { z } from "zod";
      import { defineJob } from "./src/core/ports/queue";
      import { parseEnv } from "./src/env";
      import { runWorkerProcess } from "./src/worker";

      const env = parseEnv({
        NODE_ENV: "test",
        DATABASE_URL: ":memory:",
        LOG_LEVEL: "info",
        REDIS_URL: ${JSON.stringify(REDIS_URL)},
        CACHE_PREFIX: ${JSON.stringify(prefix)},
        SHUTDOWN_TIMEOUT_MS: 5000,
        WORKER_SHUTDOWN_TIMEOUT_MS: 5000,
      });

      const slowJob = defineJob({
        name: "lifecycle.slow",
        schema: z.object({ delayMs: z.number().int().positive(), marker: z.string().min(1) }),
      });

      const runtime = await runWorkerProcess({ env });
      runtime.container.queue.registerHandler(slowJob, async (data) => {
        process.stdout.write("JOB_STARTED:" + data.marker + "\\n");
        await new Promise((resolve) => setTimeout(resolve, data.delayMs));
        process.stdout.write("JOB_FINISHED:" + data.marker + "\\n");
      });
      process.stdout.write("WORKER_READY\\n");
    `;

    const child = spawn(tsxBin, ["--input-type=module", "-e", childScript], {
      cwd: process.cwd(),
      // eslint-disable-next-line node/no-process-env
      env: { ...process.env, NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutLog = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutLog += chunk.toString("utf8");
    });

    cleanups.push(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await producer.close();
      await deletePrefixKeys(prefix);
    });

    await waitForOutput(child, "WORKER_READY");

    const marker = crypto.randomUUID();
    const jobId = await producer.enqueue(slowJobDef, { delayMs: 300, marker });

    await waitForOutput(child, `JOB_STARTED:${marker}`);

    const signalSentAt = Date.now();
    child.kill("SIGTERM");

    const exitResult = await waitForExit(child);
    const elapsedMs = Date.now() - signalSentAt;

    expect(exitResult).toEqual({ code: 0, signal: null });
    expect(stdoutLog).toContain(`JOB_FINISHED:${marker}`);
    expect(elapsedMs).toBeGreaterThanOrEqual(200);

    const job = await producer.getRawQueue().getJob(jobId);
    expect(await job?.getState()).toBe("completed");
  });
});
