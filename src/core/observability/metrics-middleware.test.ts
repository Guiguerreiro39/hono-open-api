import { createRoute, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";
import { describe, expect, it } from "vitest";

import { createErrorHandler, NotFoundError, notFoundHandler } from "@/core/errors";
import { createRouter } from "@/core/http";
import { metricsMiddleware } from "@/core/observability/metrics";
import { PromMetricsAdapter } from "@/infra/observability";

describe("metricsMiddleware", () => {
  it("records parameterized route templates including mounted sub-routers and labels unmatched 404s as __unmatched__", async () => {
    const metrics = new PromMetricsAdapter({ collectDefaultMetrics: false });

    const getItemRoute = createRoute({
      method: "get",
      path: "/items/{id}",
      request: {
        params: z.object({ id: z.string() }),
      },
      responses: {
        200: {
          description: "OK",
          content: { "application/json": { schema: z.object({ id: z.string() }) } },
        },
      },
    });

    const sub = createRouter().openapi(getItemRoute, (c) => {
      const { id } = c.req.valid("param");
      if (id === "missing") {
        throw new NotFoundError("Item not found");
      }
      return c.json({ id }, 200);
    });

    const app = createRouter()
      .use("*", metricsMiddleware(metrics))
      .notFound(notFoundHandler)
      .onError(createErrorHandler())
      .route("/api/v1", sub);

    const okRes = await app.request("/api/v1/items/123");
    expect(okRes.status).toBe(200);

    const entityNotFoundRes = await app.request("/api/v1/items/missing");
    expect(entityNotFoundRes.status).toBe(404);

    const unmatchedRes = await app.request("/wp-login.php");
    expect(unmatchedRes.status).toBe(404);

    const { body } = await metrics.render();
    expect(body).toContain("http_requests_total{method=\"GET\",route=\"/api/v1/items/:id\",status=\"200\"} 1");
    expect(body).toContain("http_request_duration_seconds_count{method=\"GET\",route=\"/api/v1/items/:id\",status=\"200\"} 1");
    expect(body).toContain("http_requests_total{method=\"GET\",route=\"/api/v1/items/:id\",status=\"404\"} 1");
    expect(body).toContain("http_requests_total{method=\"GET\",route=\"__unmatched__\",status=\"404\"} 1");
    expect(body).not.toContain("/api/v1/items/123");
    expect(body).not.toContain("/wp-login.php");
  });

  it("excludes /metrics, /health, /ready, and /favicon.ico and skips duration observation for text/event-stream", async () => {
    const metrics = new PromMetricsAdapter({ collectDefaultMetrics: false });

    const app = createRouter()
      .use("*", metricsMiddleware(metrics))
      .get("/health", c => c.json({ status: "ok" }, 200))
      .get("/ready", c => c.json({ status: "ok" }, 200))
      .get("/favicon.ico", c => c.body(null, 204))
      .get("/metrics", c => c.text("", 200))
      .get("/events", c => streamSSE(c, async (stream) => {
        await stream.writeSSE({ event: "init", data: "{}" });
        await stream.close();
      }));

    await app.request("/health");
    await app.request("/ready");
    await app.request("/favicon.ico");
    await app.request("/metrics");

    const sseRes = await app.request("/events");
    expect(sseRes.status).toBe(200);
    await sseRes.text();

    const { body } = await metrics.render();
    expect(body).not.toContain("route=\"/health\"");
    expect(body).not.toContain("route=\"/ready\"");
    expect(body).not.toContain("route=\"/favicon.ico\"");
    expect(body).not.toContain("route=\"/metrics\"");

    expect(body).toContain("http_requests_total{method=\"GET\",route=\"/events\",status=\"200\"} 1");
    expect(body).not.toContain("http_request_duration_seconds_count{method=\"GET\",route=\"/events\"");
  });
});
