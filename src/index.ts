import type { ProcessLifecycle, ProcessSignalTarget } from "@/core/lifecycle";
import type { Env } from "@/env";
import type { Container } from "@/infra/container";
import { serve } from "@hono/node-server";

import { createApp } from "@/app";
import {
  createProcessLifecycle,
  drainWorkerQueue,
  isDirectCliInvocation,
  sleep,
} from "@/core/lifecycle";
import { loadEnv } from "@/env";
import { createContainer } from "@/infra/container";
import { registerModuleJobs, registerModuleSchedules } from "@/worker";

export interface ApiServerLike {
  close: (callback?: (err?: Error) => void) => unknown;
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
  on: (event: "error", listener: (err: Error) => void) => unknown;
}

export interface StartApiRuntimeOptions {
  env: Env;
  container?: Container;
  serveFn?: (
    options: { fetch: ReturnType<typeof createApp>["fetch"]; port: number },
    listeningListener?: (info: { port: number }) => void,
  ) => ApiServerLike;
  processTarget?: ProcessSignalTarget;
  registerEmbeddedJobs?: (container: Container) => Promise<void>;
}

export interface ApiRuntime {
  container: Container;
  app: ReturnType<typeof createApp>;
  server: ApiServerLike;
  lifecycle: ProcessLifecycle;
  close: () => Promise<void>;
}

export async function startApiRuntime(options: StartApiRuntimeOptions): Promise<ApiRuntime> {
  const { env } = options;
  const container = options.container ?? createContainer(env);
  const serveFn = options.serveFn ?? ((serveOpts, onListen) => serve(serveOpts, onListen));

  let server: ApiServerLike | undefined;
  let closePromise: Promise<void> | null = null;

  const close = (): Promise<void> => {
    if (closePromise) {
      return closePromise;
    }

    closePromise = (async () => {
      container.markShuttingDown();

      if (env.SHUTDOWN_DRAIN_DELAY_MS > 0) {
        await sleep(env.SHUTDOWN_DRAIN_DELAY_MS);
      }

      container.abortShutdown();

      if (server) {
        const activeServer = server;
        await new Promise<void>((resolve) => {
          activeServer.close(() => resolve());
          activeServer.closeIdleConnections?.();
        });
      }

      if (env.WORKER_EMBEDDED) {
        await drainWorkerQueue(
          container.queue,
          env.WORKER_SHUTDOWN_TIMEOUT_MS,
          container.logger,
        );
      }

      await container.close();
    })();

    return closePromise;
  };

  const lifecycle = createProcessLifecycle({
    name: "api",
    logger: container.logger,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    onShutdown: () => close(),
    onTimeout: () => {
      server?.closeAllConnections?.();
      container.forceDisconnect();
    },
    onFatalCleanup: () => container.close(),
    processTarget: options.processTarget,
  });

  try {
    if (env.WORKER_EMBEDDED) {
      if (options.registerEmbeddedJobs) {
        await options.registerEmbeddedJobs(container);
      }
      else {
        registerModuleJobs(container);
        await registerModuleSchedules(container);
      }
      container.logger.info({ concurrency: env.WORKER_CONCURRENCY }, "Embedded worker enabled");
    }

    const app = createApp(container);

    container.logger.info({ port: env.PORT, env: env.NODE_ENV }, "Server starting");

    server = serveFn({
      fetch: app.fetch,
      port: env.PORT,
    }, (info) => {
      container.logger.info({ port: info.port }, "Server listening");
    });

    server.on("error", (err) => {
      void lifecycle.handleStartupError(err);
    });

    return {
      container,
      app,
      server,
      lifecycle,
      close,
    };
  }
  catch (err) {
    await lifecycle.handleStartupError(err);
    throw err;
  }
}

if (isDirectCliInvocation(import.meta.url)) {
  const env = loadEnv();
  await startApiRuntime({ env }).catch(() => {});
}
