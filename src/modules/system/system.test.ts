import { testClient } from "hono/testing";
import { afterEach, describe, expect, it } from "vitest";

import { createTestApp } from "../../../tests/helpers/test-app";

describe("system module", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("serves service metadata on GET / and liveness on GET /health via typed testClient", async () => {
    const ctx = await createTestApp({ APP_NAME: "Custom Starter" });
    cleanups.push(ctx.cleanup);

    const client = testClient(ctx.app);

    const rootRes = await client.index.$get();
    expect(rootRes.status).toBe(200);
    expect(await rootRes.json()).toEqual({
      name: "Custom Starter",
      status: "ok",
    });

    const healthRes = await client.health.$get();
    expect(healthRes.status).toBe(200);
    const healthBody = await healthRes.json();
    expect(healthBody.status).toBe("ok");
    expect(Number.isNaN(Date.parse(healthBody.timestamp))).toBe(false);
  });

  it("serves OpenAPI 3.0.0 spec on GET /doc with securitySchemes", async () => {
    const ctx = await createTestApp({ APP_NAME: "My API" });
    cleanups.push(ctx.cleanup);

    const res = await ctx.app.request("/doc");
    expect(res.status).toBe(200);

    const doc = await res.json();
    expect(doc.openapi).toBe("3.0.0");
    expect(doc.info.title).toBe("My API");
    expect(doc.components?.securitySchemes).toMatchObject({
      bearerAuth: { type: "http", scheme: "bearer" },
      cookieAuth: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
    });
    expect(doc.paths).toHaveProperty("/");
    expect(doc.paths).toHaveProperty("/health");
    expect(doc.paths).toHaveProperty("/ready");
  });

  it("returns 200 on GET /ready when DB is healthy and redis is skipped", async () => {
    const ctx = await createTestApp();
    cleanups.push(ctx.cleanup);

    const res = await ctx.client.ready.$get();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(Number.isNaN(Date.parse(body.timestamp))).toBe(false);
    expect(body.checks.db.status).toBe("ok");
    expect(typeof body.checks.db.latencyMs).toBe("number");
    expect(body.checks.redis).toEqual({ status: "skipped" });
  });

  it("returns 503 on GET /ready when DB probe fails without leaking internal errors", async () => {
    const ctx = await createTestApp();
    cleanups.push(ctx.cleanup);

    ctx.container.client.close();

    const res = await ctx.client.ready.$get();
    expect(res.status).toBe(503);

    const text = await res.text();
    expect(text).not.toContain("SQLITE");
    expect(text).not.toContain("closed");
    const body = JSON.parse(text);
    expect(body.status).toBe("unhealthy");
    expect(body.checks.db.status).toBe("error");
    expect(body.checks.redis).toEqual({ status: "skipped" });
  });

  it("returns 503 on GET /ready when DB probe times out or app is shutting down", async () => {
    let shuttingDown = false;
    const slowCtx = await createTestApp(
      { READINESS_TIMEOUT_MS: 20 },
      {
        checkDb: () => new Promise(() => {}),
        isShuttingDown: () => shuttingDown,
      },
    );
    cleanups.push(slowCtx.cleanup);

    const timeoutRes = await slowCtx.client.ready.$get();
    expect(timeoutRes.status).toBe(503);
    const timeoutBody = await timeoutRes.json();
    expect(timeoutBody.status).toBe("unhealthy");
    expect(timeoutBody.checks.db.status).toBe("error");

    shuttingDown = true;
    const shutdownRes = await slowCtx.client.ready.$get();
    expect(shutdownRes.status).toBe(503);
    const shutdownBody = await shutdownRes.json();
    expect(shutdownBody.status).toBe("unhealthy");
  });
});
