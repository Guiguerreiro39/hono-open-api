import { Writable } from "node:stream";
import { requestId } from "hono/request-id";
import { describe, expect, it } from "vitest";

import { createRouter } from "@/core/http";
import { createHttpLogger, createLogger } from "@/core/logger";
import { runWithTraceContext } from "@/core/observability/trace";
import { parseEnv } from "@/env";

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

describe("core logger", () => {
  it("formats ISO timestamps and redacts secret fields", () => {
    const env = parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: "file:app.db",
      REDIS_URL: "redis://localhost:6379",
      LOG_LEVEL: "info",
      BETTER_AUTH_SECRET: "a-very-long-and-secure-production-secret-32chars",
      BETTER_AUTH_URL: "https://api.example.com",
    });
    const sink = createMemoryLogStream();
    const logger = createLogger(env, sink.stream);

    logger.info({
      password: "my-password",
      token: "my-token",
      secret: "my-secret",
      nested: {
        authorization: "Bearer top-secret",
        cookie: "session=abc",
      },
      req: {
        headers: {
          authorization: "Bearer header-secret",
          cookie: "sid=xyz",
        },
      },
      res: {
        headers: {
          "set-cookie": "sid=xyz; HttpOnly",
        },
      },
      safe: "visible",
    }, "auth attempt");

    const [entry] = sink.entries();
    expect(entry).toBeDefined();
    expect(typeof entry.time).toBe("string");
    expect(Number.isNaN(Date.parse(entry.time as string))).toBe(false);
    expect(entry.password).toBe("[REDACTED]");
    expect(entry.token).toBe("[REDACTED]");
    expect(entry.secret).toBe("[REDACTED]");
    expect((entry.nested as Record<string, unknown>).authorization).toBe("[REDACTED]");
    expect((entry.nested as Record<string, unknown>).cookie).toBe("[REDACTED]");
    expect(((entry.req as Record<string, unknown>).headers as Record<string, unknown>).authorization).toBe("[REDACTED]");
    expect(((entry.req as Record<string, unknown>).headers as Record<string, unknown>).cookie).toBe("[REDACTED]");
    expect(((entry.res as Record<string, unknown>).headers as Record<string, unknown>)["set-cookie"]).toBe("[REDACTED]");
    expect(entry.safe).toBe("visible");
  });

  it("logs compact HTTP bindings and uses debug level for healthy probes below 400", async () => {
    const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "debug" });
    const sink = createMemoryLogStream();
    const logger = createLogger(env, sink.stream);

    const app = createRouter()
      .use("*", requestId())
      .use("*", createHttpLogger(logger))
      .get("/health", c => c.json({ status: "ok" }, 200))
      .get("/ready", c => c.json({ status: "unhealthy" }, 503))
      .get("/hello", c => c.json({ ok: true }, 200))
      .get("/missing", c => c.json({ error: "nope" }, 404));

    await app.request("/health", {
      headers: {
        "X-Request-Id": "req-health",
        "Authorization": "Bearer super-secret-token",
      },
    });
    await app.request("/hello", { headers: { "X-Request-Id": "req-hello" } });
    await app.request("/missing", { headers: { "X-Request-Id": "req-missing" } });
    await app.request("/ready", { headers: { "X-Request-Id": "req-ready-fail" } });

    const entries = sink.entries();
    expect(entries).toHaveLength(4);

    const [healthEntry, helloEntry, missingEntry, readyFailEntry] = entries;
    expect(healthEntry.level).toBe(20); // debug
    expect(healthEntry.reqId).toBe("req-health");
    expect(healthEntry.req).toEqual({ method: "GET", path: "/health" });
    expect(healthEntry.res).toEqual({ status: 200 });
    expect(JSON.stringify(healthEntry)).not.toContain("super-secret-token");

    expect(helloEntry.level).toBe(30); // info
    expect(missingEntry.level).toBe(40); // warn
    expect(readyFailEntry.level).toBe(50); // error
  });

  it("attaches fresh trace_id and span_id via Pino mixin when a trace context is active and omits them otherwise", () => {
    const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "info" });
    const sink = createMemoryLogStream();
    const logger = createLogger(env, sink.stream);

    logger.info("outside trace");
    runWithTraceContext(
      {
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        spanId: "00f067aa0ba902b7",
        traceFlags: "01",
      },
      () => {
        logger.info("inside trace");
      },
    );
    logger.info("after trace");

    const [outside, inside, after] = sink.entries();
    expect(outside.trace_id).toBeUndefined();
    expect(outside.span_id).toBeUndefined();
    expect(inside.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(inside.span_id).toBe("00f067aa0ba902b7");
    expect(after.trace_id).toBeUndefined();
    expect(after.span_id).toBeUndefined();
  });
});
