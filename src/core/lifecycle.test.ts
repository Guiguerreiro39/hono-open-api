import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createProcessLifecycle, drainWorkerQueue } from "@/core/lifecycle";

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

function createTestLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
}

describe("process lifecycle helper (src/core/lifecycle.ts)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("handles SIGTERM single-flight and exits 0 after onShutdown resolves", async () => {
    const proc = createTestProcessTarget();
    const logger = createTestLogger();
    const events: string[] = [];

    const lifecycle = createProcessLifecycle({
      name: "api",
      logger,
      shutdownTimeoutMs: 5000,
      processTarget: proc.target,
      onShutdown: async (signal) => {
        events.push(`shutdown:${signal}`);
      },
    });

    expect(lifecycle.isShuttingDown()).toBe(false);
    proc.emitter.emit("SIGTERM", "SIGTERM");
    expect(lifecycle.isShuttingDown()).toBe(true);

    await vi.waitFor(() => {
      expect(proc.exit).toHaveBeenCalledWith(0);
    });

    expect(events).toEqual(["shutdown:SIGTERM"]);
    expect(proc.emitter.listenerCount("SIGTERM")).toBe(0);
    expect(proc.emitter.listenerCount("SIGINT")).toBe(0);
    expect(proc.emitter.listenerCount("uncaughtException")).toBe(0);
    expect(proc.emitter.listenerCount("unhandledRejection")).toBe(0);
  });

  it("forces immediate exit(1) on second SIGINT/SIGTERM without calling onShutdown twice", async () => {
    const proc = createTestProcessTarget();
    const logger = createTestLogger();
    let resolveDrain!: () => void;
    const onShutdown = vi.fn(
      () => new Promise<void>((resolve) => {
        resolveDrain = resolve;
      }),
    );

    createProcessLifecycle({
      name: "worker",
      logger,
      shutdownTimeoutMs: 5000,
      processTarget: proc.target,
      onShutdown,
    });

    proc.emitter.emit("SIGINT", "SIGINT");
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(proc.exit).not.toHaveBeenCalled();

    proc.emitter.emit("SIGTERM", "SIGTERM");
    expect(onShutdown).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(1);

    resolveDrain();
  });

  it("escalates with onTimeout and exits 1 when shutdown exceeds shutdownTimeoutMs", async () => {
    vi.useFakeTimers();
    const proc = createTestProcessTarget();
    const logger = createTestLogger();
    const onTimeout = vi.fn();

    createProcessLifecycle({
      name: "api",
      logger,
      shutdownTimeoutMs: 250,
      processTarget: proc.target,
      onShutdown: () => new Promise(() => {}),
      onTimeout,
    });

    proc.emitter.emit("SIGTERM", "SIGTERM");
    await vi.advanceTimersByTimeAsync(249);
    expect(onTimeout).not.toHaveBeenCalled();
    expect(proc.exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(onTimeout).toHaveBeenCalledWith("SIGTERM");
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(1);
  });

  it("logs fatal, awaits onFatalCleanup, and exits 1 on handleStartupError", async () => {
    const proc = createTestProcessTarget();
    const logger = createTestLogger();
    const order: string[] = [];

    const lifecycle = createProcessLifecycle({
      name: "api",
      logger,
      shutdownTimeoutMs: 5000,
      processTarget: proc.target,
      onShutdown: async () => {},
      onFatalCleanup: async () => {
        order.push("cleanup");
      },
    });

    await lifecycle.handleStartupError(new Error("EADDRINUSE"));

    expect(logger.fatal).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["cleanup"]);
    expect(proc.exit).toHaveBeenCalledWith(1);
  });

  it("logs fatal and exits 1 immediately on uncaughtException and unhandledRejection without graceful drain", async () => {
    const proc1 = createTestProcessTarget();
    const logger1 = createTestLogger();
    const onShutdown1 = vi.fn(async () => {});

    createProcessLifecycle({
      name: "api",
      logger: logger1,
      shutdownTimeoutMs: 5000,
      processTarget: proc1.target,
      onShutdown: onShutdown1,
    });

    proc1.emitter.emit("uncaughtException", new Error("boom"));
    expect(logger1.fatal).toHaveBeenCalledTimes(1);
    expect(onShutdown1).not.toHaveBeenCalled();
    expect(proc1.exit).toHaveBeenCalledWith(1);

    const proc2 = createTestProcessTarget();
    const logger2 = createTestLogger();
    const onShutdown2 = vi.fn(async () => {});

    createProcessLifecycle({
      name: "worker",
      logger: logger2,
      shutdownTimeoutMs: 5000,
      processTarget: proc2.target,
      onShutdown: onShutdown2,
    });

    proc2.emitter.emit("unhandledRejection", new Error("rejected"));
    expect(logger2.fatal).toHaveBeenCalledTimes(1);
    expect(onShutdown2).not.toHaveBeenCalled();
    expect(proc2.exit).toHaveBeenCalledWith(1);
  });

  it("forces worker close when drainWorkerQueue exceeds timeoutMs", async () => {
    vi.useFakeTimers();
    const logger = createTestLogger();
    const forceClose = vi.fn();
    const closeWorker = vi.fn(() => new Promise<void>(() => {}));

    const drainPromise = drainWorkerQueue(
      { closeWorker, forceClose, close: async () => {} },
      100,
      logger,
    );

    await vi.advanceTimersByTimeAsync(99);
    expect(forceClose).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await drainPromise;
    expect(forceClose).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
