import type { PubSubPort, RealtimeEvent, RealtimeEventListener } from "@/core/ports/pubsub";
import { Writable } from "node:stream";
import { requestId } from "hono/request-id";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BadRequestError, createErrorHandler } from "@/core/errors";
import { createRouter } from "@/core/http";
import { createLogger } from "@/core/logger";
import {
  createEventStream,
  createLiveQueryStream,
  createSseConnectionTracker,
} from "@/core/realtime/sse";
import { parseEnv } from "@/env";
import { PromMetricsAdapter } from "@/infra/observability";
import { MemoryPubSubAdapter } from "@/infra/realtime";
import { createSseReader, readSseEvents } from "../../../tests/helpers/sse";

describe("sse streaming helpers (createLiveQueryStream & createEventStream)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.useRealTimers();
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("subscribes before initial fetch, emits init with retry: 3000, coalesces overlapping ticks into one trailing update, and cleans up metrics/subscriptions on abort", async () => {
    const pubsub = new MemoryPubSubAdapter();
    const metrics = new PromMetricsAdapter({ collectDefaultMetrics: false });
    const tracker = createSseConnectionTracker(10);
    const shutdown = new AbortController();
    cleanups.push(async () => {
      shutdown.abort();
      await pubsub.close();
    });

    const eventsOrder: string[] = [];
    let fetchNumber = 0;
    let resolvePendingFetch: ((value: { version: number }) => void) | undefined;

    const app = createRouter()
      .use("*", requestId())
      .onError(createErrorHandler());

    app.get("/live", (c) => {
      return createLiveQueryStream({
        c,
        pubsub,
        topic: "tasks:u1",
        metrics,
        connectionTracker: tracker,
        shutdownSignal: shutdown.signal,
        fetcher: async () => {
          fetchNumber++;
          eventsOrder.push(`fetch-${fetchNumber}:subCount=${pubsub.listenerCount("tasks:u1")}`);
          if (fetchNumber === 2) {
            return await new Promise<{ version: number }>((resolve) => {
              resolvePendingFetch = resolve;
            });
          }
          return { version: fetchNumber };
        },
      });
    });

    const res = await app.request("/live");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(tracker.activeCount).toBe(1);

    const sse = createSseReader(res);
    cleanups.push(() => sse.close());

    const initEvt = await sse.next();
    expect(initEvt).toMatchObject({
      event: "init",
      retry: 3000,
    });
    expect(JSON.parse(initEvt!.data)).toEqual({ version: 1 });
    expect(eventsOrder[0]).toBe("fetch-1:subCount=1");

    const renderedActive = await metrics.render();
    expect(renderedActive.body).toContain("sse_active_connections 1");
    expect(renderedActive.body).toContain("sse_connections_total 1");

    // Publish event 1 -> starts fetch #2 (held open)
    await pubsub.publish("tasks:u1", { action: "create", data: { id: "1" } });
    // Wait a tick for fetch #2 to start
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(fetchNumber).toBe(2);

    // Publish 4 overlapping events while fetch #2 is inFlight -> must coalesce into ONE trailing fetch #3
    await pubsub.publish("tasks:u1", { action: "update", data: { id: "2" } });
    await pubsub.publish("tasks:u1", { action: "update", data: { id: "3" } });
    await pubsub.publish("tasks:u1", { action: "update", data: { id: "4" } });
    await pubsub.publish("tasks:u1", { action: "delete", data: { id: "5" } });

    resolvePendingFetch!({ version: 2 });

    const update1 = await sse.next();
    const update2 = await sse.next();
    expect(update1?.event).toBe("update");
    expect(JSON.parse(update1!.data)).toEqual({ version: 2 });
    expect(update2?.event).toBe("update");
    expect(JSON.parse(update2!.data)).toEqual({ version: 3 });
    expect(fetchNumber).toBe(3);

    // Closing reader triggers onAbort -> decrements gauge, releases tracker, unsubscribes once
    await sse.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(tracker.activeCount).toBe(0);
    expect(pubsub.listenerCount("tasks:u1")).toBe(0);

    const renderedClosed = await metrics.render();
    expect(renderedClosed.body).toContain("sse_active_connections 0");
    expect(renderedClosed.body).toContain("sse_connections_total 1");
  });

  it("captures pubsub ticks arriving during initial init fetch into a trailing update without missing updates", async () => {
    const pubsub = new MemoryPubSubAdapter();
    cleanups.push(() => pubsub.close());

    let fetchCount = 0;
    let releaseInit!: () => void;

    const app = createRouter()
      .use("*", requestId())
      .onError(createErrorHandler());

    app.get("/live", (c) => {
      return createLiveQueryStream({
        c,
        pubsub,
        topic: "tasks:race",
        fetcher: async () => {
          fetchCount++;
          if (fetchCount === 1) {
            await new Promise<void>((resolve) => {
              releaseInit = resolve;
            });
            return { items: ["stale-snapshot"] };
          }
          return { items: ["fresh-after-race"] };
        },
      });
    });

    const resPromise = app.request("/live");
    // Wait for subscribe + init fetch to begin
    await new Promise(resolve => setTimeout(resolve, 15));
    expect(pubsub.listenerCount("tasks:race")).toBe(1);

    // Mutate while init snapshot is still in flight
    await pubsub.publish("tasks:race", { action: "create", data: { id: "new" } });
    releaseInit();

    const res = await resPromise;
    const events = await readSseEvents(res, { count: 2 });
    expect(events[0].event).toBe("init");
    expect(JSON.parse(events[0].data)).toEqual({ items: ["stale-snapshot"] });
    expect(events[1].event).toBe("update");
    expect(JSON.parse(events[1].data)).toEqual({ items: ["fresh-after-race"] });
    expect(fetchCount).toBe(2);
  });

  it("enforces MAX_SSE_CONNECTIONS pre-header (503 ServiceUnavailableError JSON) and releases slot if subscribe fails", async () => {
    const pubsub = new MemoryPubSubAdapter();
    const metrics = new PromMetricsAdapter({ collectDefaultMetrics: false });
    const tracker = createSseConnectionTracker(1);
    cleanups.push(() => pubsub.close());

    const app = createRouter()
      .use("*", requestId())
      .onError(createErrorHandler());

    app.get("/live", (c) => {
      return createLiveQueryStream({
        c,
        pubsub,
        topic: "tasks:cap",
        metrics,
        connectionTracker: tracker,
        fetcher: async () => ({ ok: true }),
      });
    });

    const firstRes = await app.request("/live");
    expect(firstRes.status).toBe(200);
    const sse = createSseReader(firstRes);
    cleanups.push(() => sse.close());
    await sse.next();

    const rejectedRes = await app.request("/live", {
      headers: { "X-Request-Id": "req-sse-full" },
    });
    expect(rejectedRes.status).toBe(503);
    expect(rejectedRes.headers.get("content-type")).toContain("application/json");
    expect(await rejectedRes.json()).toEqual({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Too many active SSE connections",
        requestId: "req-sse-full",
      },
    });

    await sse.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(tracker.activeCount).toBe(0);

    // Subscribe failure on second topic cleans up first topic and releases capacity slot
    let subscribeCalls = 0;
    const unsubSpy: string[] = [];
    const flakyPubSub: PubSubPort = {
      publish: async () => {},
      subscribe: async <T = unknown>(topic: string, _listener: RealtimeEventListener<T>) => {
        subscribeCalls++;
        if (subscribeCalls === 2) {
          throw new Error("Redis subscribe failed");
        }
        return async () => {
          unsubSpy.push(topic);
        };
      },
      close: async () => {},
    };

    const flakyApp = createRouter()
      .use("*", requestId())
      .onError(createErrorHandler());
    flakyApp.get("/flaky", c => createLiveQueryStream({
      c,
      pubsub: flakyPubSub,
      topic: ["topic-1", "topic-2"],
      metrics,
      connectionTracker: tracker,
      fetcher: async () => ({ ok: true }),
    }));

    const flakyRes = await flakyApp.request("/flaky", {
      headers: { "X-Request-Id": "req-sub-fail" },
    });
    expect(flakyRes.status).toBe(500);
    expect(unsubSpy).toEqual(["topic-1"]);
    expect(tracker.activeCount).toBe(0);
    const metricsText = (await metrics.render()).body;
    expect(metricsText).toContain("sse_active_connections 0");
  });

  it("emits 15_000ms ping heartbeats, sanitized error events without leaking internals, and closes on shutdownSignal", async () => {
    vi.useFakeTimers();

    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, cb) {
        lines.push(chunk.toString("utf8"));
        cb();
      },
    });
    const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "error" });
    const logger = createLogger(env, sink);

    const pubsub = new MemoryPubSubAdapter();
    const metrics = new PromMetricsAdapter({ collectDefaultMetrics: false });
    const shutdown = new AbortController();
    cleanups.push(async () => {
      shutdown.abort();
      await pubsub.close();
    });

    let callNum = 0;
    const app = createRouter()
      .use("*", requestId())
      .onError(createErrorHandler());

    app.get("/live", (c) => {
      return createLiveQueryStream({
        c,
        pubsub,
        topic: "tasks:err",
        metrics,
        logger,
        shutdownSignal: shutdown.signal,
        fetcher: async () => {
          callNum++;
          if (callNum === 1) {
            return { items: [] };
          }
          if (callNum === 2) {
            throw new BadRequestError("Invalid cursor");
          }
          throw new Error("SQLITE_CORRUPT: internal secret stack details");
        },
      });
    });

    const res = await app.request("/live", {
      headers: { "X-Request-Id": "req-sse-err" },
    });
    expect(res.status).toBe(200);
    const sse = createSseReader(res, 5000);
    cleanups.push(() => sse.close());

    const initEvt = await sse.next();
    expect(initEvt?.event).toBe("init");

    // Advance 15_000ms for ping heartbeat
    await vi.advanceTimersByTimeAsync(15_000);
    const pingEvt = await sse.next();
    expect(pingEvt?.event).toBe("ping");
    expect(typeof (JSON.parse(pingEvt!.data) as { timestamp: number }).timestamp).toBe("number");

    // AppError (4xx) preserves code/message with requestId
    await pubsub.publish("tasks:err", { action: "update" });
    const appErrEvt = await sse.next();
    expect(appErrEvt?.event).toBe("error");
    expect(JSON.parse(appErrEvt!.data)).toEqual({
      error: {
        code: "BAD_REQUEST",
        message: "Invalid cursor",
        requestId: "req-sse-err",
      },
    });

    // Unexpected Error sanitizes message and never leaks internal error string
    await pubsub.publish("tasks:err", { action: "update" });
    const internalErrEvt = await sse.next();
    expect(internalErrEvt?.event).toBe("error");
    expect(JSON.parse(internalErrEvt!.data)).toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
        requestId: "req-sse-err",
      },
    });
    expect(internalErrEvt!.data).not.toContain("SQLITE_CORRUPT");

    // Aborting shutdownSignal closes the stream cleanly and decrements gauge once
    shutdown.abort();
    const eof = await sse.next();
    expect(eof).toBeNull();
    expect(pubsub.listenerCount("tasks:err")).toBe(0);
    expect((await metrics.render()).body).toContain("sse_active_connections 0");
    expect(lines.join("")).toContain("SQLITE_CORRUPT");
  });

  it("supports createEventStream for direct PubSubPort event delivery with filtering, mapping, and cleanup", async () => {
    const pubsub = new MemoryPubSubAdapter();
    const metrics = new PromMetricsAdapter({ collectDefaultMetrics: false });
    const shutdown = new AbortController();
    cleanups.push(async () => {
      shutdown.abort();
      await pubsub.close();
    });

    const app = createRouter()
      .use("*", requestId())
      .onError(createErrorHandler());

    app.get("/events", (c) => {
      return createEventStream<{ id: string; hidden?: boolean }>({
        c,
        pubsub,
        topic: "jobs:events",
        metrics,
        shutdownSignal: shutdown.signal,
        initialData: { connected: true },
        filter: evt => evt.data?.hidden !== true,
        mapEvent: (evt: RealtimeEvent<{ id: string; hidden?: boolean }>) => ({
          event: "update",
          data: { action: evt.action, id: evt.data?.id },
        }),
      });
    });

    const res = await app.request("/events");
    expect(res.status).toBe(200);
    const sse = createSseReader(res);
    cleanups.push(() => sse.close());

    const initEvt = await sse.next();
    expect(initEvt).toMatchObject({ event: "init", retry: 3000 });
    expect(JSON.parse(initEvt!.data)).toEqual({ connected: true });

    await pubsub.publish("jobs:events", { action: "create", data: { id: "skip-me", hidden: true } });
    await pubsub.publish("jobs:events", { action: "create", data: { id: "keep-me" } });

    const updateEvt = await sse.next();
    expect(updateEvt?.event).toBe("update");
    expect(JSON.parse(updateEvt!.data)).toEqual({ action: "create", id: "keep-me" });

    await sse.close();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(pubsub.listenerCount("jobs:events")).toBe(0);
    expect((await metrics.render()).body).toContain("sse_active_connections 0");
  });
});
