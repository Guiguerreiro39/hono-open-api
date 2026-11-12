import type { QueuePort } from "@/core/ports/queue";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export type ProcessLifecycleEvent
  = | "SIGINT"
    | "SIGTERM"
    | "uncaughtException"
    | "unhandledRejection";

export interface ProcessSignalTarget {
  on: (event: ProcessLifecycleEvent, listener: (...args: any[]) => void) => unknown;
  off: (event: ProcessLifecycleEvent, listener: (...args: any[]) => void) => unknown;
  exit: (code: number) => unknown;
}

export interface LifecycleLogger {
  info: (obj: Record<string, unknown>, msg?: string) => void;
  warn: (obj: Record<string, unknown>, msg?: string) => void;
  error: (obj: Record<string, unknown>, msg?: string) => void;
  fatal: (obj: Record<string, unknown>, msg?: string) => void;
}

export interface ProcessLifecycleOptions {
  name: string;
  logger: LifecycleLogger;
  shutdownTimeoutMs: number;
  onShutdown: (signal: NodeJS.Signals) => Promise<void>;
  onTimeout?: (signal: NodeJS.Signals) => Promise<void> | void;
  onFatalCleanup?: () => Promise<void>;
  processTarget?: ProcessSignalTarget;
}

export interface ProcessLifecycle {
  isShuttingDown: () => boolean;
  shutdown: (signal: NodeJS.Signals) => Promise<void>;
  handleStartupError: (err: unknown) => Promise<void>;
  dispose: () => void;
}

/**
 * Coordinates idempotent SIGINT/SIGTERM draining, unref'd timeout escalation,
 * second-signal force exit, startup failure cleanup, and fatal uncaught errors.
 */
export function createProcessLifecycle(options: ProcessLifecycleOptions): ProcessLifecycle {
  const {
    name,
    logger,
    shutdownTimeoutMs,
    onShutdown,
    onTimeout,
    onFatalCleanup,
    processTarget = process,
  } = options;

  let shuttingDown = false;
  let disposed = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  let shutdownPromise: Promise<void> | null = null;
  let startupErrorPromise: Promise<void> | null = null;

  const clearForceTimer = () => {
    if (forceTimer !== undefined) {
      clearTimeout(forceTimer);
      forceTimer = undefined;
    }
  };

  const onSigint = () => {
    void shutdown("SIGINT");
  };

  const onSigterm = () => {
    void shutdown("SIGTERM");
  };

  const onUncaughtException = (err: unknown) => {
    logger.fatal({ service: name, err }, "Uncaught exception; exiting immediately");
    dispose();
    processTarget.exit(1);
  };

  const onUnhandledRejection = (reason: unknown) => {
    logger.fatal({ service: name, err: reason }, "Unhandled promise rejection; exiting immediately");
    dispose();
    processTarget.exit(1);
  };

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    clearForceTimer();
    processTarget.off("SIGINT", onSigint);
    processTarget.off("SIGTERM", onSigterm);
    processTarget.off("uncaughtException", onUncaughtException);
    processTarget.off("unhandledRejection", onUnhandledRejection);
  }

  function shutdown(signal: NodeJS.Signals): Promise<void> {
    if (shuttingDown) {
      logger.warn({ service: name, signal }, "Second signal received; forcing immediate exit");
      dispose();
      processTarget.exit(1);
      return shutdownPromise ?? Promise.resolve();
    }

    shuttingDown = true;
    logger.info({ service: name, signal }, "Process shutting down");

    let timedOut = false;
    forceTimer = setTimeout(() => {
      timedOut = true;
      logger.error(
        { service: name, signal, timeoutMs: shutdownTimeoutMs },
        "Graceful shutdown timed out; forcing exit",
      );
      void Promise.resolve(onTimeout?.(signal))
        .catch((err) => {
          logger.error({ service: name, err }, "Forced shutdown escalation failed");
        })
        .finally(() => {
          dispose();
          processTarget.exit(1);
        });
    }, shutdownTimeoutMs);
    forceTimer.unref?.();

    shutdownPromise = (async () => {
      try {
        await onShutdown(signal);
        if (!timedOut) {
          dispose();
          processTarget.exit(0);
        }
      }
      catch (err) {
        if (!timedOut) {
          logger.error({ service: name, signal, err }, "Graceful shutdown failed");
          dispose();
          processTarget.exit(1);
        }
      }
    })();

    return shutdownPromise;
  }

  function handleStartupError(err: unknown): Promise<void> {
    if (startupErrorPromise) {
      return startupErrorPromise;
    }

    shuttingDown = true;
    startupErrorPromise = (async () => {
      logger.fatal({ service: name, err }, "Process startup failed");
      try {
        await onFatalCleanup?.();
      }
      catch (cleanupErr) {
        logger.error({ service: name, err: cleanupErr }, "Startup failure cleanup failed");
      }
      dispose();
      processTarget.exit(1);
    })();

    return startupErrorPromise;
  }

  processTarget.on("SIGINT", onSigint);
  processTarget.on("SIGTERM", onSigterm);
  processTarget.on("uncaughtException", onUncaughtException);
  processTarget.on("unhandledRejection", onUnhandledRejection);

  return {
    isShuttingDown: () => shuttingDown,
    shutdown,
    handleStartupError,
    dispose,
  };
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function drainWorkerQueue(
  queue: Pick<QueuePort, "closeWorker" | "forceClose" | "close">,
  timeoutMs: number,
  logger: Pick<LifecycleLogger, "warn">,
): Promise<void> {
  const closeFn = queue.closeWorker
    ? () => queue.closeWorker!()
    : () => queue.close();

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closeFn(),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          logger.warn({ timeoutMs }, "Worker drain timed out; forcing close");
          queue.forceClose?.();
          resolve();
        }, timeoutMs);
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

export function isDirectCliInvocation(importMetaUrl: string): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }
  try {
    return pathToFileURL(realpathSync(entrypoint)).href === importMetaUrl;
  }
  catch {
    return false;
  }
}
