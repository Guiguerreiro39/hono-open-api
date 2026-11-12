import { describe, expect, it } from "vitest";

import { createMetricsAdapter, NoopMetricsAdapter, PromMetricsAdapter } from "@/infra/observability";

describe("promMetricsAdapter and noopMetricsAdapter", () => {
  it("records all MetricsPort operations into an isolated Prometheus registry", async () => {
    const metrics = new PromMetricsAdapter({ collectDefaultMetrics: false });

    metrics.recordHttpRequest({
      method: "GET",
      route: "/api/v1/me",
      status: 200,
      durationSeconds: 0.042,
    });
    metrics.recordHttpRequest({
      method: "GET",
      route: "/api/v1/tasks/live",
      status: 200,
      durationSeconds: 0.001,
      observeDuration: false,
    });

    metrics.incSseConnection();
    metrics.incSseConnection();
    metrics.decSseConnection();

    metrics.recordJob({
      name: "tasks.audit",
      status: "completed",
      durationSeconds: 0.25,
    });
    metrics.recordCacheOp({
      operation: "get",
      result: "hit",
    });
    metrics.recordRateLimit({
      tier: "api",
      decision: "allowed",
    });

    const rendered = await metrics.render();
    expect(rendered.contentType).toContain("text/plain");
    expect(rendered.contentType).toContain("0.0.4");

    expect(rendered.body).toContain("http_requests_total{method=\"GET\",route=\"/api/v1/me\",status=\"200\"} 1");
    expect(rendered.body).toContain("http_request_duration_seconds_count{method=\"GET\",route=\"/api/v1/me\",status=\"200\"} 1");

    expect(rendered.body).toContain("http_requests_total{method=\"GET\",route=\"/api/v1/tasks/live\",status=\"200\"} 1");
    expect(rendered.body).not.toContain("http_request_duration_seconds_count{method=\"GET\",route=\"/api/v1/tasks/live\"");

    expect(rendered.body).toContain("sse_active_connections 1");
    expect(rendered.body).toContain("sse_connections_total 2");

    expect(rendered.body).toContain("jobs_processed_total{name=\"tasks.audit\",status=\"completed\"} 1");
    expect(rendered.body).toContain("job_duration_seconds_count{name=\"tasks.audit\",status=\"completed\"} 1");

    expect(rendered.body).toContain("cache_operations_total{operation=\"get\",result=\"hit\"} 1");
    expect(rendered.body).toContain("rate_limit_decisions_total{tier=\"api\",decision=\"allowed\"} 1");
    expect(rendered.body).not.toContain("process_cpu_");
  });

  it("isolates registries across multiple PromMetricsAdapter instances without metric collisions", async () => {
    const adapterA = new PromMetricsAdapter({ collectDefaultMetrics: false });
    const adapterB = new PromMetricsAdapter({ collectDefaultMetrics: false });

    adapterA.recordHttpRequest({
      method: "POST",
      route: "/api/v1/tasks",
      status: 201,
      durationSeconds: 0.015,
    });

    const [renderA, renderB] = await Promise.all([adapterA.render(), adapterB.render()]);
    expect(renderA.body).toContain("http_requests_total{method=\"POST\",route=\"/api/v1/tasks\",status=\"201\"} 1");
    expect(renderB.body).not.toContain("/api/v1/tasks");
  });

  it("skips collectDefaultMetrics when NODE_ENV=test and enables it outside test", async () => {
    const testAdapter = createMetricsAdapter({ NODE_ENV: "test", METRICS_ENABLED: true });
    const testRender = await testAdapter.render();
    expect(testRender.body).not.toContain("nodejs_version_info");

    const prodAdapter = createMetricsAdapter({ NODE_ENV: "production", METRICS_ENABLED: true });
    const prodRender = await prodAdapter.render();
    expect(prodRender.body).toContain("nodejs_version_info");
  });

  it("supports every MetricsPort method cleanly in NoopMetricsAdapter and when METRICS_ENABLED=false", async () => {
    const noop = new NoopMetricsAdapter();

    noop.recordHttpRequest({
      method: "GET",
      route: "/api/v1/me",
      status: 200,
      durationSeconds: 0.1,
    });
    noop.incSseConnection();
    noop.decSseConnection();
    noop.recordJob({
      name: "auth.pruneExpired",
      status: "failed",
      durationSeconds: 0.5,
    });
    noop.recordCacheOp({
      operation: "set",
      result: "error",
    });
    noop.recordRateLimit({
      tier: "auth_mutation",
      decision: "limited",
    });

    const rendered = await noop.render();
    expect(rendered.body).toBe("");
    expect(rendered.contentType).toContain("text/plain");

    const disabledAdapter = createMetricsAdapter({ NODE_ENV: "production", METRICS_ENABLED: false });
    expect(disabledAdapter).toBeInstanceOf(NoopMetricsAdapter);
    expect((await disabledAdapter.render()).body).toBe("");
  });
});
