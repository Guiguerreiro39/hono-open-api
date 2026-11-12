import type { MemoryQueueAdapter } from "@/infra/queue";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parseEnv } from "@/env";
import { createContainer } from "@/infra/container";
import { authPruneExpiredJob } from "@/modules/auth/auth.jobs";
import { tasksAuditJob } from "@/modules/tasks/tasks.jobs";
import { createWorkerRuntime, registerModuleJobs, runWorkerProcess } from "@/worker";

function createTestProcessTarget() {
  const emitter = new EventEmitter();
  const exit = vi.fn();
  return {
    emitter,
    exit,
    target: {
      on: (event: string, listener: (...args: any[]) => void) => emitter.on(event, listener),
      off: (event: string, listener: (...args: any[]) => void) => emitter.off(event, listener),
      exit,
    },
  };
}

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

  it("flips /health to 503 during drain while keeping /metrics scrapable until worker drain finishes, then closes metricsServer and container", async () => {
    const env = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: ":memory:",
      LOG_LEVEL: "silent",
      WORKER_METRICS_PORT: 0,
      WORKER_SHUTDOWN_TIMEOUT_MS: 5000,
    });
    const container = createContainer(env, { worker: true });
    const events: string[] = [];

    let resolveWorkerDrain!: () => void;
    const workerDrainGate = new Promise<void>((resolve) => {
      resolveWorkerDrain = resolve;
    });

    const origMarkShuttingDown = container.markShuttingDown;
    container.markShuttingDown = () => {
      events.push("markShuttingDown");
      origMarkShuttingDown();
    };

    const origCloseWorker = container.queue.closeWorker!.bind(container.queue);
    container.queue.closeWorker = async () => {
      events.push("worker.drain.start");
      await workerDrainGate;
      await origCloseWorker();
      events.push("worker.drain.done");
    };

    const origContainerClose = container.close.bind(container);
    container.close = async () => {
      events.push("container.close");
      await origContainerClose();
    };

    const runtime = await createWorkerRuntime(env, { container });
    cleanups.push(runtime.close);

    const metricsServer = runtime.metricsServer!;
    const origMetricsClose = metricsServer.close.bind(metricsServer);
    metricsServer.close = ((cb?: (err?: Error) => void) => {
      events.push("metricsServer.close");
      return origMetricsClose(cb);
    }) as typeof metricsServer.close;

    const closePromise = runtime.close();

    // Wait a tick for closeWorker to be entered
    await vi.waitFor(() => {
      expect(events).toContain("worker.drain.start");
    });

    // During worker drain: metricsServer is still listening, /health returns 503, and /metrics returns 200
    expect(runtime.metricsServer!.listening).toBe(true);
    const healthDuringDrain = await runtime.metricsApp!.request("/health");
    expect(healthDuringDrain.status).toBe(503);
    const metricsDuringDrain = await runtime.metricsApp!.request("/metrics");
    expect(metricsDuringDrain.status).toBe(200);

    resolveWorkerDrain();
    await closePromise;

    expect(events).toEqual([
      "markShuttingDown",
      "worker.drain.start",
      "worker.drain.done",
      "metricsServer.close",
      "container.close",
    ]);
    expect(container.client.closed).toBe(true);
  });

  it("forces worker close when drain exceeds WORKER_SHUTDOWN_TIMEOUT_MS, then closes metricsServer and container", async () => {
    vi.useFakeTimers();
    const env = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: ":memory:",
      LOG_LEVEL: "silent",
      WORKER_SHUTDOWN_TIMEOUT_MS: 50,
    });
    const container = createContainer(env, { worker: true });
    container.queue.closeWorker = () => new Promise<void>(() => {});
    const forceCloseSpy = vi.spyOn(container.queue, "forceClose");

    const runtime = await createWorkerRuntime(env, { container });
    const closePromise = runtime.close();

    await vi.advanceTimersByTimeAsync(50);
    await closePromise;
    vi.useRealTimers();

    expect(forceCloseSpy).toHaveBeenCalledTimes(1);
    expect(container.client.closed).toBe(true);
  });

  it("runs worker process lifecycle: SIGTERM exit 0, timeout exit 1, second signal exit 1, and startup error cleanup", async () => {
    const env = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: ":memory:",
      LOG_LEVEL: "silent",
      SHUTDOWN_TIMEOUT_MS: 5000,
    });

    // 1. Normal SIGTERM
    const proc1 = createTestProcessTarget();
    const container1 = createContainer(env, { worker: true });
    const runtime1 = await runWorkerProcess({ env, container: container1, processTarget: proc1.target });
    cleanups.push(async () => {
      runtime1?.lifecycle.dispose();
      await runtime1?.close();
    });

    proc1.emitter.emit("SIGTERM", "SIGTERM");
    await vi.waitFor(() => {
      expect(proc1.exit).toHaveBeenCalledWith(0);
    });
    expect(container1.client.closed).toBe(true);

    // 2. Startup error cleanup
    const proc2 = createTestProcessTarget();
    const container2 = createContainer(env, { worker: true });
    const fatalSpy = vi.spyOn(container2.logger, "fatal");
    const closeSpy = vi.spyOn(container2, "close");
    container2.queue.upsertSchedule = async () => {
      throw new Error("Schedule registration failed");
    };

    await expect(runWorkerProcess({
      env,
      container: container2,
      processTarget: proc2.target,
    })).rejects.toThrow("Schedule registration failed");

    expect(fatalSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalled();
    expect(proc2.exit).toHaveBeenCalledWith(1);
    expect(container2.client.closed).toBe(true);
  });
});
