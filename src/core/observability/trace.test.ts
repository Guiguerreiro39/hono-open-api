import { Writable } from "node:stream";
import { requestId } from "hono/request-id";
import { describe, expect, it } from "vitest";

import { createRouter } from "@/core/http";
import { createHttpLogger, createLogger } from "@/core/logger";
import {
  formatTraceparent,
  getTraceContext,
  parseTraceparent,
  runWithTraceContext,
  traceContext,
} from "@/core/observability/trace";
import { parseEnv } from "@/env";

const W3C_TRACEPARENT_REGEX = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

function createMemoryLogStream() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString("utf8"));
      callback();
    },
  });
  return {
    stream,
    entries: () => lines
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("w3c traceContext and Pino trace mixin", () => {
  it("propagates valid inbound traceparent trace_id into handlers, async work, and Pino logs without emitting traceparent response headers", async () => {
    const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "info" });
    const sink = createMemoryLogStream();
    const logger = createLogger(env, sink.stream);

    const inboundTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const inboundParentId = "00f067aa0ba902b7";
    const inboundHeader = `00-${inboundTraceId}-${inboundParentId}-01`;

    let observedContext: ReturnType<typeof getTraceContext>;
    let observedFormatted: string | undefined;

    const app = createRouter()
      .use("*", requestId())
      .use("*", traceContext())
      .use("*", createHttpLogger(logger))
      .get("/work", async (c) => {
        await Promise.resolve();
        observedContext = getTraceContext();
        observedFormatted = formatTraceparent();
        logger.info({ action: "service_step" }, "inside async work");
        c.get("logger").info("inside handler");
        return c.json({ ok: true }, 200);
      });

    const res = await app.request("/work", {
      headers: {
        "X-Request-Id": "req-trace-1",
        "traceparent": inboundHeader,
      },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Request-Id")).toBe("req-trace-1");
    expect(res.headers.get("traceparent")).toBeNull();

    expect(observedContext).toBeDefined();
    expect(observedContext?.traceId).toBe(inboundTraceId);
    expect(observedContext?.parentSpanId).toBe(inboundParentId);
    expect(observedContext?.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(observedContext?.spanId).not.toBe(inboundParentId);
    expect(observedContext?.traceFlags).toBe("01");

    expect(observedFormatted).toMatch(W3C_TRACEPARENT_REGEX);
    expect(observedFormatted).toBe(`00-${inboundTraceId}-${observedContext?.spanId}-01`);

    expect(getTraceContext()).toBeUndefined();
    expect(formatTraceparent()).toBeUndefined();

    const entries = sink.entries();
    expect(entries).toHaveLength(3);
    for (const entry of entries) {
      expect(entry.trace_id).toBe(inboundTraceId);
      expect(entry.span_id).toBe(observedContext?.spanId);
    }
  });

  it("mints fresh non-zero trace and span IDs when traceparent is missing or malformed", async () => {
    const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "info" });
    const sink = createMemoryLogStream();
    const logger = createLogger(env, sink.stream);

    const app = createRouter()
      .use("*", requestId())
      .use("*", traceContext())
      .use("*", createHttpLogger(logger))
      .get("/ping", (c) => {
        return c.json({
          trace: getTraceContext(),
          formatted: formatTraceparent(),
        }, 200);
      });

    const malformedInputs = [
      undefined,
      "",
      "not-a-traceparent",
      "00-4BF92F3577B34DA6A3CE929D0E0E4736-00F067AA0BA902B7-01",
      "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      "00-1234-5678-01",
    ];

    for (const header of malformedInputs) {
      expect(parseTraceparent(header)).toBeNull();
      const res = await app.request("/ping", header === undefined ? undefined : { headers: { traceparent: header } });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.trace.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(body.trace.traceId).not.toBe("0".repeat(32));
      expect(body.trace.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(body.trace.spanId).not.toBe("0".repeat(16));
      expect(body.trace.parentSpanId).toBeUndefined();
      expect(body.trace.traceFlags).toBe("01");
      expect(body.formatted).toBe(`00-${body.trace.traceId}-${body.trace.spanId}-01`);
    }

    const entries = sink.entries();
    expect(entries).toHaveLength(malformedInputs.length);
    for (const entry of entries) {
      expect(entry.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(entry.span_id).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("isolates trace context across overlapping async requests and supports runWithTraceContext", async () => {
    const traceA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const traceB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    const app = createRouter()
      .use("*", traceContext())
      .get("/slow/:label", async (c) => {
        const delayMs = c.req.param("label") === "a" ? 25 : 5;
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return c.json({
          label: c.req.param("label"),
          traceId: getTraceContext()?.traceId,
        }, 200);
      });

    const [resA, resB] = await Promise.all([
      app.request("/slow/a", { headers: { traceparent: `00-${traceA}-1111111111111111-01` } }),
      app.request("/slow/b", { headers: { traceparent: `00-${traceB}-2222222222222222-01` } }),
    ]);

    expect(await resA.json()).toEqual({ label: "a", traceId: traceA });
    expect(await resB.json()).toEqual({ label: "b", traceId: traceB });

    const jobResult = runWithTraceContext(
      { traceId: traceA, spanId: "1234567890abcdef", traceFlags: "01" },
      () => formatTraceparent(),
    );
    expect(jobResult).toBe(`00-${traceA}-1234567890abcdef-01`);
  });
});
