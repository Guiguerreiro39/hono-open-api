import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseEnv } from "@/env";
import { startApiRuntime } from "@/index";
import { createContainer } from "@/infra/container";

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

function createFakeServer() {
  const emitter = new EventEmitter();
  const calls: string[] = [];
  let closeCallback: ((err?: Error) => void) | undefined;

  const server = {
    close: vi.fn((cb?: (err?: Error) => void) => {
      calls.push("server.close");
      closeCallback = cb;
      cb?.();
    }),
    closeIdleConnections: vi.fn(() => {
      calls.push("server.closeIdleConnections");
    }),
    closeAllConnections: vi.fn(() => {
      calls.push("server.closeAllConnections");
    }),
    on: (event: "error", listener: (err: Error) => void) => {
      emitter.on(event, listener);
      return server;
    },
    emitError: (err: Error) => emitter.emit("error", err),
    triggerPendingClose: () => closeCallback?.(),
    calls,
  };

  return server;
}

describe("api process lifecycle and drain order (src/index.ts)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.useRealTimers();
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("drains sequentially: isShuttingDown -> SHUTDOWN_DRAIN_DELAY_MS -> abort SSE -> server.close -> embedded worker -> container.close", async () => {
    vi.useFakeTimers();
    const env = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: ":memory:",
      LOG_LEVEL: "silent",
      PORT: 0,
      WORKER_EMBEDDED: true,
      SHUTDOWN_DRAIN_DELAY_MS: 50,
      SHUTDOWN_TIMEOUT_MS: 5000,
    });
    const container = createContainer(env);
    const proc = createTestProcessTarget();
    const server = createFakeServer();
    const events: string[] = [];

    const origMarkShuttingDown = container.markShuttingDown;
    container.markShuttingDown = () => {
      events.push("markShuttingDown");
      origMarkShuttingDown();
    };

    const origAbortShutdown = container.abortShutdown;
    container.abortShutdown = () => {
      events.push("abortShutdown");
      origAbortShutdown();
    };

    container.shutdownSignal?.addEventListener("abort", () => {
      events.push("shutdownSignal:abort");
    });

    server.close = vi.fn((cb?: (err?: Error) => void) => {
      events.push("server.close");
      cb?.();
    });
    server.closeIdleConnections = vi.fn(() => {
      events.push("server.closeIdleConnections");
    });

    const origCloseWorker = container.queue.closeWorker!.bind(container.queue);
    container.queue.closeWorker = async () => {
      events.push("worker.close");
      await origCloseWorker();
    };

    const origContainerClose = container.close.bind(container);
    container.close = async () => {
      events.push("container.close");
      await origContainerClose();
    };

    const runtime = await startApiRuntime({
      env,
      container,
      processTarget: proc.target,
      serveFn: (_opts, onListen) => {
        onListen?.({ port: 9999 });
        return server;
      },
      registerEmbeddedJobs: async () => {
        events.push("registerEmbeddedJobs");
      },
    });
    cleanups.push(async () => {
      runtime.lifecycle.dispose();
      await origContainerClose();
    });

    // Signal shutdown
    proc.emitter.emit("SIGTERM", "SIGTERM");

    // Immediately: /ready returns 503 because isShuttingDown() is true,
    // while shutdownSignal is NOT aborted yet during SHUTDOWN_DRAIN_DELAY_MS.
    expect(container.isShuttingDown?.()).toBe(true);
    expect(container.shutdownSignal?.aborted).toBe(false);
    const readyDuringDelay = await runtime.app.request("/ready");
    expect(readyDuringDelay.status).toBe(503);
    expect(await readyDuringDelay.json()).toMatchObject({
      status: "unhealthy",
      checks: {
        db: { status: "skipped" },
        redis: { status: "skipped" },
      },
    });
    expect(server.close).not.toHaveBeenCalled();

    // Advance past SHUTDOWN_DRAIN_DELAY_MS
    await vi.advanceTimersByTimeAsync(50);

    await vi.waitFor(() => {
      expect(proc.exit).toHaveBeenCalledWith(0);
    });

    expect(events).toEqual([
      "registerEmbeddedJobs",
      "markShuttingDown",
      "abortShutdown",
      "shutdownSignal:abort",
      "server.close",
      "server.closeIdleConnections",
      "worker.close",
      "container.close",
    ]);
  });

  it("skips embedded worker drain when WORKER_EMBEDDED=false", async () => {
    const env = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: ":memory:",
      LOG_LEVEL: "silent",
      PORT: 0,
      WORKER_EMBEDDED: false,
      SHUTDOWN_TIMEOUT_MS: 5000,
    });
    const container = createContainer(env);
    const proc = createTestProcessTarget();
    const server = createFakeServer();
    const closeWorkerSpy = vi.spyOn(container.queue, "closeWorker");

    const runtime = await startApiRuntime({
      env,
      container,
      processTarget: proc.target,
      serveFn: () => server,
    });
    cleanups.push(async () => {
      runtime.lifecycle.dispose();
      await container.close();
    });

    proc.emitter.emit("SIGINT", "SIGINT");
    await vi.waitFor(() => {
      expect(proc.exit).toHaveBeenCalledWith(0);
    });

    expect(closeWorkerSpy).not.toHaveBeenCalled();
    expect(container.client.closed).toBe(true);
  });

  it("escalates on SHUTDOWN_TIMEOUT_MS to server.closeAllConnections, forceDisconnect, and exit 1", async () => {
    vi.useFakeTimers();
    const env = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: ":memory:",
      LOG_LEVEL: "silent",
      PORT: 0,
      SHUTDOWN_TIMEOUT_MS: 100,
    });
    const container = createContainer(env);
    const proc = createTestProcessTarget();
    const server = createFakeServer();
    server.close = vi.fn(() => {
      // Simulate hung HTTP connection keeping server.close pending
    });
    const forceDisconnectSpy = vi.spyOn(container, "forceDisconnect");

    const runtime = await startApiRuntime({
      env,
      container,
      processTarget: proc.target,
      serveFn: () => server,
    });
    cleanups.push(async () => {
      runtime.lifecycle.dispose();
      await container.close();
    });

    proc.emitter.emit("SIGTERM", "SIGTERM");
    await vi.advanceTimersByTimeAsync(100);

    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(forceDisconnectSpy).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(1);
  });

  it("logs fatal, closes container, and exits 1 on startup failure and server error events", async () => {
    const env = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: ":memory:",
      LOG_LEVEL: "silent",
      PORT: 0,
    });

    // 1. Boot error (e.g. embedded schedule registration fails)
    const bootContainer = createContainer(env);
    const bootProc = createTestProcessTarget();
    const bootFatal = vi.spyOn(bootContainer.logger, "fatal");
    const bootClose = vi.spyOn(bootContainer, "close");

    await expect(startApiRuntime({
      env: { ...env, WORKER_EMBEDDED: true },
      container: bootContainer,
      processTarget: bootProc.target,
      serveFn: () => createFakeServer(),
      registerEmbeddedJobs: async () => {
        throw new Error("Redis unreachable during boot");
      },
    })).rejects.toThrow("Redis unreachable during boot");

    expect(bootFatal).toHaveBeenCalledTimes(1);
    expect(bootClose).toHaveBeenCalledTimes(1);
    expect(bootProc.exit).toHaveBeenCalledWith(1);
    expect(bootContainer.client.closed).toBe(true);

    // 2. HTTP server error event (e.g. EADDRINUSE)
    const serverContainer = createContainer(env);
    const serverProc = createTestProcessTarget();
    const serverFatal = vi.spyOn(serverContainer.logger, "fatal");
    const serverClose = vi.spyOn(serverContainer, "close");
    const server = createFakeServer();

    const runtime = await startApiRuntime({
      env,
      container: serverContainer,
      processTarget: serverProc.target,
      serveFn: () => server,
    });
    cleanups.push(async () => {
      runtime.lifecycle.dispose();
      await serverContainer.close();
    });

    server.emitError(Object.assign(new Error("listen EADDRINUSE"), { code: "EADDRINUSE" }));

    await vi.waitFor(() => {
      expect(serverProc.exit).toHaveBeenCalledWith(1);
    });
    expect(serverFatal).toHaveBeenCalledTimes(1);
    expect(serverClose).toHaveBeenCalledTimes(1);
    expect(serverContainer.client.closed).toBe(true);
  });

  it("repeatedly sweeps idle keep-alive connections until server.close completes, then stops the interval", async () => {
    vi.useFakeTimers();
    const env = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: ":memory:",
      LOG_LEVEL: "silent",
      PORT: 0,
      SHUTDOWN_TIMEOUT_MS: 2000,
    });
    const container = createContainer(env);
    const proc = createTestProcessTarget();
    const server = createFakeServer();

    let closeCb: ((err?: Error) => void) | undefined;
    server.close = vi.fn((cb?: (err?: Error) => void) => {
      closeCb = cb;
    });

    let idleSweepCount = 0;
    server.closeIdleConnections = vi.fn(() => {
      idleSweepCount += 1;
      // Simulate an SSE keep-alive socket finishing its flush and transitioning to idle after 2 ticks
      if (idleSweepCount === 3) {
        closeCb?.();
      }
    });

    const runtime = await startApiRuntime({
      env,
      container,
      processTarget: proc.target,
      serveFn: () => server,
    });
    cleanups.push(async () => {
      runtime.lifecycle.dispose();
      await container.close();
    });

    proc.emitter.emit("SIGTERM", "SIGTERM");
    await vi.advanceTimersByTimeAsync(100);

    expect(idleSweepCount).toBe(3);
    expect(proc.exit).toHaveBeenCalledWith(0);

    // Interval must be cleared once server.close completes
    await vi.advanceTimersByTimeAsync(200);
    expect(idleSweepCount).toBe(3);
  });
});
