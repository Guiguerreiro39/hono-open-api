import type { ServerType } from "@hono/node-server";
import type { Env } from "@/env";
import type { Container } from "@/infra/container";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { requestId } from "hono/request-id";

import { createErrorHandler, notFoundHandler } from "@/core/errors";
import { createRouter } from "@/core/http";
import { createMetricsEndpointHandler } from "@/core/observability/metrics";
import { loadEnv } from "@/env";
import { createContainer } from "@/infra/container";
import { registerAuthJobs, registerAuthSchedules } from "@/modules/auth/auth.jobs";
import { registerFilesJobs, registerFilesSchedules } from "@/modules/files/files.jobs";
import { registerTasksJobs } from "@/modules/tasks/tasks.jobs";

export type ModuleJobsContainer = Pick<Container, "queue" | "auth" | "storage" | "fileRepository">;

export function registerModuleJobs(container: ModuleJobsContainer): void {
  registerTasksJobs(container.queue);
  registerAuthJobs(container.queue, { auth: container.auth });
  registerFilesJobs(container.queue, {
    storage: container.storage,
    fileRepository: container.fileRepository,
  });
}

export async function registerModuleSchedules(container: Pick<Container, "queue">): Promise<void> {
  await registerAuthSchedules(container.queue);
  await registerFilesSchedules(container.queue);
}

export interface WorkerRuntime {
  container: Container;
  metricsApp?: ReturnType<typeof createWorkerObservabilityApp>;
  metricsServer?: ServerType;
  metricsPort?: number;
  close: () => Promise<void>;
}

async function pingWithTimeout(ping: () => Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      ping(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Redis health check timed out")), timeoutMs);
        timer.unref?.();
      }),
    ]);
  }
  finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function createWorkerObservabilityApp(container: Container) {
  const app = createRouter()
    .use("*", requestId())
    .notFound(notFoundHandler)
    .onError(createErrorHandler(container.logger));

  app.get("/health", async (c) => {
    const timestamp = new Date().toISOString();

    if (container.isShuttingDown()) {
      return c.json({
        status: "unhealthy" as const,
        timestamp,
        checks: {
          worker: { status: "error" as const, message: "Shutting down" },
          redis: { status: "skipped" as const },
        },
      }, 503);
    }

    const workerRunning = container.queue.isWorkerRunning?.() ?? true;
    const workerCheck = workerRunning
      ? { status: "ok" as const }
      : { status: "error" as const, message: "Worker is not running" };

    let redisCheck: { status: "ok" | "error" | "skipped"; message?: string };
    if (container.env.REDIS_URL !== undefined) {
      try {
        await pingWithTimeout(() => container.queue.ping(), container.env.READINESS_TIMEOUT_MS);
        redisCheck = { status: "ok" };
      }
      catch {
        redisCheck = { status: "error", message: "Redis health check failed" };
      }
    }
    else {
      redisCheck = { status: "skipped" };
    }

    const unhealthy = workerCheck.status === "error" || redisCheck.status === "error";
    return c.json({
      status: unhealthy ? ("unhealthy" as const) : ("ok" as const),
      timestamp,
      checks: {
        worker: workerCheck,
        redis: redisCheck,
      },
    }, unhealthy ? 503 : 200);
  });

  app.get("/metrics", createMetricsEndpointHandler({
    env: container.env,
    metrics: container.metrics,
  }));

  return app;
}

async function startWorkerMetricsServer(
  obsApp: ReturnType<typeof createWorkerObservabilityApp>,
  port: number,
): Promise<{ server: ServerType; port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve(
      {
        fetch: obsApp.fetch,
        port,
        hostname: "0.0.0.0",
      },
      (info) => {
        resolve({ server, port: info.port });
      },
    );
    server.once("error", reject);
  });
}

async function closeHttpServer(server: ServerType | undefined): Promise<void> {
  if (!server) {
    return;
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
  });
}

export async function createWorkerRuntime(env: Env): Promise<WorkerRuntime> {
  const container = createContainer(env, { worker: true });
  let metricsApp: ReturnType<typeof createWorkerObservabilityApp> | undefined;
  let metricsServer: ServerType | undefined;
  let metricsPort: number | undefined;

  try {
    registerModuleJobs(container);
    await registerModuleSchedules(container);

    if (env.WORKER_METRICS_PORT !== undefined) {
      metricsApp = createWorkerObservabilityApp(container);
      const started = await startWorkerMetricsServer(metricsApp, env.WORKER_METRICS_PORT);
      metricsServer = started.server;
      metricsPort = started.port;
      container.logger.info({ port: metricsPort }, "Worker observability server listening");
    }
  }
  catch (err) {
    await closeHttpServer(metricsServer);
    await container.close();
    throw err;
  }

  let closePromise: Promise<void> | null = null;
  const close = async () => {
    if (closePromise) {
      return closePromise;
    }
    closePromise = (async () => {
      await container.close();
      await closeHttpServer(metricsServer);
    })();
    return closePromise;
  };

  return {
    container,
    metricsApp,
    metricsServer,
    metricsPort,
    close,
  };
}

function isDirectCliInvocation(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }
  try {
    return pathToFileURL(realpathSync(entrypoint)).href === import.meta.url;
  }
  catch {
    return false;
  }
}

if (isDirectCliInvocation()) {
  const env = loadEnv();
  const runtime = await createWorkerRuntime(env);

  runtime.container.logger.info(
    {
      env: env.NODE_ENV,
      concurrency: env.WORKER_CONCURRENCY,
      metricsPort: runtime.metricsPort,
    },
    "Worker started",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      runtime.container.logger.warn({ signal }, "Second signal received; forcing worker exit");
      process.exit(1);
    }
    shuttingDown = true;
    runtime.container.logger.info({ signal }, "Worker shutting down");

    const forceTimer = setTimeout(() => {
      runtime.container.logger.error("Worker shutdown timed out; forcing exit");
      process.exit(1);
    }, env.WORKER_SHUTDOWN_TIMEOUT_MS + 1000);
    forceTimer.unref();

    try {
      await runtime.close();
      clearTimeout(forceTimer);
      process.exit(0);
    }
    catch (err) {
      runtime.container.logger.error({ err }, "Worker shutdown failed");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}
