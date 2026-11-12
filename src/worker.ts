import type { ServerType } from "@hono/node-server";
import type { ProcessLifecycle, ProcessSignalTarget } from "@/core/lifecycle";
import type { Env } from "@/env";
import type { Container } from "@/infra/container";
import { serve } from "@hono/node-server";
import { requestId } from "hono/request-id";

import { createErrorHandler, notFoundHandler } from "@/core/errors";
import { createRouter } from "@/core/http";
import {
  createProcessLifecycle,
  drainWorkerQueue,
  isDirectCliInvocation,
} from "@/core/lifecycle";
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

export interface CreateWorkerRuntimeOptions {
  container?: Container;
}

export async function createWorkerRuntime(
  env: Env,
  options?: CreateWorkerRuntimeOptions,
): Promise<WorkerRuntime> {
  const container = options?.container ?? createContainer(env, { worker: true });
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
      container.markShuttingDown();
      await drainWorkerQueue(
        container.queue,
        env.WORKER_SHUTDOWN_TIMEOUT_MS,
        container.logger,
      );
      await closeHttpServer(metricsServer);
      await container.close();
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

export interface RunWorkerProcessOptions {
  env?: Env;
  container?: Container;
  processTarget?: ProcessSignalTarget;
}

export interface WorkerProcessRuntime extends WorkerRuntime {
  lifecycle: ProcessLifecycle;
}

export async function runWorkerProcess(
  options?: RunWorkerProcessOptions,
): Promise<WorkerProcessRuntime> {
  const env = options?.env ?? loadEnv();
  const container = options?.container ?? createContainer(env, { worker: true });
  let runtime: WorkerRuntime | undefined;

  const lifecycle = createProcessLifecycle({
    name: "worker",
    logger: container.logger,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    onShutdown: async () => {
      if (runtime) {
        await runtime.close();
      }
      else {
        container.markShuttingDown();
        await container.close();
      }
    },
    onTimeout: () => {
      if (
        runtime?.metricsServer
        && "closeAllConnections" in runtime.metricsServer
        && typeof runtime.metricsServer.closeAllConnections === "function"
      ) {
        runtime.metricsServer.closeAllConnections();
      }
      container.forceDisconnect();
    },
    onFatalCleanup: async () => {
      if (runtime) {
        await runtime.close();
      }
      else {
        await container.close();
      }
    },
    processTarget: options?.processTarget,
  });

  try {
    runtime = await createWorkerRuntime(env, { container });
    container.logger.info(
      {
        env: env.NODE_ENV,
        concurrency: env.WORKER_CONCURRENCY,
        metricsPort: runtime.metricsPort,
      },
      "Worker started",
    );

    return {
      ...runtime,
      lifecycle,
    };
  }
  catch (err) {
    await lifecycle.handleStartupError(err);
    throw err;
  }
}

if (isDirectCliInvocation(import.meta.url)) {
  await runWorkerProcess().catch(() => {});
}
