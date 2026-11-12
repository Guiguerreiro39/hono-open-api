import type { Context } from "hono";
import type { SSEStreamingApi } from "hono/streaming";
import type { Logger } from "pino";

import type { MetricsPort } from "@/core/ports/metrics";
import type { PubSubPort, RealtimeEvent, RealtimeEventListener } from "@/core/ports/pubsub";
import type { AppBindings } from "@/core/types";
import { streamSSE } from "hono/streaming";

import { AppError, getRequestId, ServiceUnavailableError } from "@/core/errors";

export const DEFAULT_SSE_HEARTBEAT_MS = 15_000;
export const DEFAULT_SSE_RETRY_MS = 3_000;

export interface SseEventNames {
  init?: string;
  update?: string;
  ping?: string;
}

export interface SseConnectionTracker {
  tryAcquire: () => (() => void) | null;
  readonly activeCount: number;
  readonly maxConnections: number;
}

export function createSseConnectionTracker(maxConnections: number): SseConnectionTracker {
  let active = 0;

  return {
    get activeCount() {
      return active;
    },
    get maxConnections() {
      return maxConnections;
    },
    tryAcquire() {
      if (maxConnections > 0 && active >= maxConnections) {
        return null;
      }
      active++;
      let released = false;
      return () => {
        if (released) {
          return;
        }
        released = true;
        active = Math.max(0, active - 1);
      };
    },
  };
}

export interface LiveQueryStreamOptions<T> {
  c: Context<AppBindings>;
  pubsub: PubSubPort;
  topic: string | string[];
  fetcher: () => Promise<T>;
  eventNames?: SseEventNames;
  heartbeatIntervalMs?: number;
  retryMs?: number;
  metrics?: MetricsPort;
  logger?: Logger;
  shutdownSignal?: AbortSignal;
  connectionTracker?: SseConnectionTracker;
}

export interface EventStreamOptions<T = unknown> {
  c: Context<AppBindings>;
  pubsub: PubSubPort;
  topic: string | string[];
  filter?: (event: RealtimeEvent<T>) => boolean;
  mapEvent?: (event: RealtimeEvent<T>) => { event?: string; data: unknown; id?: string } | null;
  initialData?: unknown | (() => Promise<unknown> | unknown);
  eventNames?: SseEventNames;
  heartbeatIntervalMs?: number;
  retryMs?: number;
  metrics?: MetricsPort;
  logger?: Logger;
  shutdownSignal?: AbortSignal;
  connectionTracker?: SseConnectionTracker;
}

interface SanitizedSseErrorPayload {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

type SseLogger = Pick<Logger, "error" | "warn">;

function toSanitizedSseError(
  err: unknown,
  requestId: string,
  logger?: SseLogger,
): SanitizedSseErrorPayload {
  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger?.error({ err, requestId, code: err.code }, err.message);
    }
    else {
      logger?.warn({ requestId, code: err.code, status: err.status }, err.message);
    }

    return {
      error: {
        code: err.code,
        message: err.status >= 500 ? "Internal server error" : err.message,
        requestId,
      },
    };
  }

  logger?.error({ err, requestId }, "Unhandled SSE stream error");
  return {
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "Internal server error",
      requestId,
    },
  };
}

interface ManagedStreamSetup<T> {
  c: Context<AppBindings>;
  pubsub: PubSubPort;
  topic: string | string[];
  onMessage: RealtimeEventListener<T>;
  pingEventName?: string;
  heartbeatIntervalMs?: number;
  metrics?: MetricsPort;
  logger?: Logger;
  shutdownSignal?: AbortSignal;
  connectionTracker?: SseConnectionTracker;
  onStart: (controls: {
    stream: SSEStreamingApi;
    isClosed: () => boolean;
    writeError: (err: unknown) => Promise<void>;
    close: () => void;
  }) => Promise<void>;
}

async function openManagedSseStream<T>(setup: ManagedStreamSetup<T>): Promise<Response> {
  const {
    c,
    pubsub,
    topic,
    onMessage,
    pingEventName = "ping",
    heartbeatIntervalMs = DEFAULT_SSE_HEARTBEAT_MS,
    metrics,
    logger,
    shutdownSignal,
    connectionTracker,
    onStart,
  } = setup;

  if (shutdownSignal?.aborted) {
    throw new ServiceUnavailableError("Server is shutting down");
  }

  const releaseConnection = connectionTracker ? connectionTracker.tryAcquire() : null;
  if (connectionTracker && !releaseConnection) {
    throw new ServiceUnavailableError("Too many active SSE connections");
  }

  const topics = [...new Set(Array.isArray(topic) ? topic : [topic])];
  const unsubs: Array<() => Promise<void>> = [];

  try {
    for (const item of topics) {
      unsubs.push(await pubsub.subscribe<T>(item, onMessage));
    }
  }
  catch (err) {
    await Promise.allSettled(unsubs.map(unsub => unsub()));
    releaseConnection?.();
    throw err;
  }

  const requestId = getRequestId(c);
  const resolvedLogger = logger ?? c.get("logger");

  metrics?.incSseConnection();

  return streamSSE(c, async (stream) => {
    let closed = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let resolveClosed!: () => void;
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const cleanup = () => {
      if (closed) {
        return;
      }
      closed = true;

      if (heartbeatTimer !== undefined) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }

      shutdownSignal?.removeEventListener("abort", cleanup);
      c.req.raw.signal?.removeEventListener("abort", cleanup);

      metrics?.decSseConnection();
      releaseConnection?.();
      void Promise.allSettled(unsubs.map(unsub => unsub()));
      resolveClosed();
    };

    const writeError = async (err: unknown) => {
      const payload = toSanitizedSseError(err, requestId, resolvedLogger);
      if (closed) {
        return;
      }
      try {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify(payload),
        });
      }
      catch {
        cleanup();
      }
    };

    stream.onAbort(cleanup);
    shutdownSignal?.addEventListener("abort", cleanup, { once: true });
    c.req.raw.signal?.addEventListener("abort", cleanup, { once: true });

    if (shutdownSignal?.aborted || c.req.raw.signal?.aborted) {
      cleanup();
      return;
    }

    if (heartbeatIntervalMs > 0) {
      heartbeatTimer = setInterval(() => {
        if (closed) {
          return;
        }
        void stream.writeSSE({
          event: pingEventName,
          data: JSON.stringify({ timestamp: Date.now() }),
        }).catch(() => {
          cleanup();
        });
      }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    }

    try {
      await onStart({
        stream,
        isClosed: () => closed,
        writeError,
        close: cleanup,
      });

      if (!closed) {
        await closedPromise;
      }
    }
    finally {
      cleanup();
    }
  });
}

export async function createLiveQueryStream<T>(
  options: LiveQueryStreamOptions<T>,
): Promise<Response> {
  const {
    c,
    pubsub,
    topic,
    fetcher,
    eventNames,
    heartbeatIntervalMs = DEFAULT_SSE_HEARTBEAT_MS,
    retryMs = DEFAULT_SSE_RETRY_MS,
    metrics,
    logger,
    shutdownSignal,
    connectionTracker,
  } = options;

  const initEvent = eventNames?.init ?? "init";
  const updateEvent = eventNames?.update ?? "update";
  const pingEvent = eventNames?.ping ?? "ping";

  // Start inFlight=true so any pubsub ticks arriving between subscribe() and
  // initial fetcher() completion mark pending=true for a trailing refetch.
  let inFlight = true;
  let pending = false;
  let streamControls: {
    stream: SSEStreamingApi;
    isClosed: () => boolean;
    writeError: (err: unknown) => Promise<void>;
    close: () => void;
  } | undefined;

  const runFetch = async (eventName: string, includeRetry: boolean): Promise<void> => {
    const controls = streamControls;
    if (!controls || controls.isClosed()) {
      return;
    }

    try {
      const data = await fetcher();
      if (controls.isClosed()) {
        return;
      }
      await controls.stream.writeSSE({
        event: eventName,
        data: JSON.stringify(data),
        ...(includeRetry ? { retry: retryMs } : {}),
      });
    }
    catch (err) {
      await controls.writeError(err);
    }
  };

  const drainUpdates = async (): Promise<void> => {
    const controls = streamControls;
    if (!controls) {
      return;
    }
    while (pending && !controls.isClosed()) {
      pending = false;
      await runFetch(updateEvent, false);
    }
  };

  const handleTick: RealtimeEventListener<unknown> = async () => {
    if (streamControls?.isClosed()) {
      return;
    }
    if (inFlight) {
      pending = true;
      return;
    }

    inFlight = true;
    try {
      pending = true;
      await drainUpdates();
    }
    finally {
      inFlight = false;
    }
  };

  return openManagedSseStream({
    c,
    pubsub,
    topic,
    onMessage: handleTick,
    pingEventName: pingEvent,
    heartbeatIntervalMs,
    metrics,
    logger,
    shutdownSignal,
    connectionTracker,
    onStart: async (controls) => {
      streamControls = controls;
      try {
        await runFetch(initEvent, true);
        await drainUpdates();
      }
      finally {
        inFlight = false;
      }
    },
  });
}

export async function createEventStream<T = unknown>(
  options: EventStreamOptions<T>,
): Promise<Response> {
  const {
    c,
    pubsub,
    topic,
    filter,
    mapEvent,
    initialData,
    eventNames,
    heartbeatIntervalMs = DEFAULT_SSE_HEARTBEAT_MS,
    retryMs = DEFAULT_SSE_RETRY_MS,
    metrics,
    logger,
    shutdownSignal,
    connectionTracker,
  } = options;

  const initEvent = eventNames?.init ?? "init";
  const updateEvent = eventNames?.update ?? "update";
  const pingEvent = eventNames?.ping ?? "ping";

  let initWritten = false;
  const bufferedEvents: Array<RealtimeEvent<T>> = [];
  let writeQueue: Promise<void> = Promise.resolve();
  let streamControls: {
    stream: SSEStreamingApi;
    isClosed: () => boolean;
    writeError: (err: unknown) => Promise<void>;
    close: () => void;
  } | undefined;

  const enqueueEvent = (event: RealtimeEvent<T>) => {
    writeQueue = writeQueue.then(async () => {
      const controls = streamControls;
      if (!controls || controls.isClosed()) {
        return;
      }
      try {
        if (filter && !filter(event)) {
          return;
        }
        const mapped = mapEvent
          ? mapEvent(event)
          : { event: updateEvent, data: event };
        if (!mapped) {
          return;
        }
        await controls.stream.writeSSE({
          event: mapped.event ?? updateEvent,
          data: JSON.stringify(mapped.data),
          ...(mapped.id !== undefined ? { id: mapped.id } : {}),
        });
      }
      catch (err) {
        await controls.writeError(err);
      }
    });
  };

  const handleMessage: RealtimeEventListener<T> = (event) => {
    if (streamControls?.isClosed()) {
      return;
    }
    if (!initWritten) {
      bufferedEvents.push(event);
      return;
    }
    enqueueEvent(event);
  };

  return openManagedSseStream<T>({
    c,
    pubsub,
    topic,
    onMessage: handleMessage,
    pingEventName: pingEvent,
    heartbeatIntervalMs,
    metrics,
    logger,
    shutdownSignal,
    connectionTracker,
    onStart: async (controls) => {
      streamControls = controls;
      try {
        const initPayload = typeof initialData === "function"
          ? await (initialData as () => Promise<unknown> | unknown)()
          : initialData !== undefined
            ? initialData
            : { timestamp: Date.now() };

        if (!controls.isClosed()) {
          await controls.stream.writeSSE({
            event: initEvent,
            data: JSON.stringify(initPayload),
            retry: retryMs,
          });
        }
      }
      catch (err) {
        await controls.writeError(err);
      }

      initWritten = true;
      while (bufferedEvents.length > 0 && !controls.isClosed()) {
        const nextEvent = bufferedEvents.shift();
        if (nextEvent) {
          enqueueEvent(nextEvent);
        }
      }
      await writeQueue;
    },
  });
}
