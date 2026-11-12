import type { MemoryQueueAdapter } from "@/infra/queue";

import { afterEach, describe, expect, it } from "vitest";
import { parseEnv } from "@/env";
import { authPruneExpiredJob } from "@/modules/auth/auth.jobs";
import { tasksAuditJob } from "@/modules/tasks/tasks.jobs";
import { createWorkerRuntime, registerModuleJobs } from "@/worker";

describe("worker runtime (src/worker.ts)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("registers module handlers and daily auth.pruneExpired schedule, processes jobs, and serves /health + /metrics on WORKER_METRICS_PORT", async () => {
    const env = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: ":memory:",
      LOG_LEVEL: "silent",
      WORKER_METRICS_PORT: 0,
    });

    const runtime = await createWorkerRuntime(env);
    cleanups.push(runtime.close);

    expect(runtime.metricsPort).toBeTypeOf("number");
    expect(runtime.metricsPort).toBeGreaterThan(0);

    const queue = runtime.container.queue as MemoryQueueAdapter;
    const schedules = queue.getSchedules();
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      schedulerId: "auth.pruneExpired",
      schedule: { pattern: "0 3 * * *", tz: "UTC" },
      template: { name: "auth.pruneExpired", data: {} },
    });

    // Enqueue registered jobs and drain
    await queue.enqueue(tasksAuditJob, {
      action: "created",
      taskId: crypto.randomUUID(),
      userId: "u-1",
      actorId: "u-1",
      taskName: "Worker test task",
      done: false,
    });
    await queue.drain();
    expect(queue.getJobs().every(j => j.status === "completed")).toBe(true);

    // Check /health and /metrics endpoints via worker observability app
    const healthRes = await runtime.metricsApp!.request("/health");
    expect(healthRes.status).toBe(200);
    const healthBody = await healthRes.json() as {
      status: string;
      checks: { worker: { status: string }; redis: { status: string } };
    };
    expect(healthBody.status).toBe("ok");
    expect(healthBody.checks.worker.status).toBe("ok");
    expect(healthBody.checks.redis.status).toBe("skipped");

    const metricsRes = await runtime.metricsApp!.request("/metrics");
    expect(metricsRes.status).toBe(200);
    const metricsBody = await metricsRes.text();
    expect(metricsBody).toContain("jobs_processed_total{name=\"tasks.audit\",status=\"completed\"} 1");

    await runtime.close();

    // After close(), /health reports 503 unhealthy (shutting down)
    const shuttingDownHealth = await runtime.metricsApp!.request("/health");
    expect(shuttingDownHealth.status).toBe(503);
  });

  it("enforces METRICS_TOKEN and METRICS_ENABLED=false on worker metrics endpoint", async () => {
    const protectedEnv = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: ":memory:",
      LOG_LEVEL: "silent",
      WORKER_METRICS_PORT: 0,
      METRICS_TOKEN: "worker-secret-token",
    });
    const protectedRuntime = await createWorkerRuntime(protectedEnv);
    cleanups.push(protectedRuntime.close);

    const unauthRes = await protectedRuntime.metricsApp!.request("/metrics");
    expect(unauthRes.status).toBe(401);

    const authRes = await protectedRuntime.metricsApp!.request("/metrics", {
      headers: { Authorization: "Bearer worker-secret-token" },
    });
    expect(authRes.status).toBe(200);

    const disabledEnv = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: ":memory:",
      LOG_LEVEL: "silent",
      WORKER_METRICS_PORT: 0,
      METRICS_ENABLED: false,
    });
    const disabledRuntime = await createWorkerRuntime(disabledEnv);
    cleanups.push(disabledRuntime.close);

    const disabledRes = await disabledRuntime.metricsApp!.request("/metrics");
    expect(disabledRes.status).toBe(404);
  });

  it("exposes registerModuleJobs for test harness and embedded worker wiring", async () => {
    expect(typeof registerModuleJobs).toBe("function");
    expect(authPruneExpiredJob.name).toBe("auth.pruneExpired");
  });
});
