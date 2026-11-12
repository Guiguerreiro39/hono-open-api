import type {
  CacheOpMetricParams,
  HttpRequestMetricParams,
  JobMetricParams,
  MetricsPort,
  RateLimitMetricParams,
  RenderedMetrics,
} from "@/core/ports/metrics";
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";

const HTTP_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const JOB_DURATION_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60];

export interface PromMetricsAdapterOptions {
  collectDefaultMetrics?: boolean;
}

export class PromMetricsAdapter implements MetricsPort {
  readonly registry: Registry;

  private readonly httpRequestsTotal: Counter<"method" | "route" | "status">;
  private readonly httpRequestDurationSeconds: Histogram<"method" | "route" | "status">;
  private readonly sseActiveConnections: Gauge;
  private readonly sseConnectionsTotal: Counter;
  private readonly jobsProcessedTotal: Counter<"name" | "status">;
  private readonly jobDurationSeconds: Histogram<"name" | "status">;
  private readonly cacheOperationsTotal: Counter<"operation" | "result">;
  private readonly rateLimitDecisionsTotal: Counter<"tier" | "decision">;

  constructor(options?: PromMetricsAdapterOptions) {
    this.registry = new Registry();

    if (options?.collectDefaultMetrics ?? true) {
      collectDefaultMetrics({ register: this.registry });
    }

    this.httpRequestsTotal = new Counter({
      name: "http_requests_total",
      help: "Total number of HTTP requests",
      labelNames: ["method", "route", "status"] as const,
      registers: [this.registry],
    });

    this.httpRequestDurationSeconds = new Histogram({
      name: "http_request_duration_seconds",
      help: "HTTP request duration in seconds",
      labelNames: ["method", "route", "status"] as const,
      buckets: HTTP_DURATION_BUCKETS,
      registers: [this.registry],
    });

    this.sseActiveConnections = new Gauge({
      name: "sse_active_connections",
      help: "Number of active SSE connections",
      registers: [this.registry],
    });

    this.sseConnectionsTotal = new Counter({
      name: "sse_connections_total",
      help: "Total number of SSE connections opened",
      registers: [this.registry],
    });

    this.jobsProcessedTotal = new Counter({
      name: "jobs_processed_total",
      help: "Total number of background jobs processed",
      labelNames: ["name", "status"] as const,
      registers: [this.registry],
    });

    this.jobDurationSeconds = new Histogram({
      name: "job_duration_seconds",
      help: "Background job processing duration in seconds",
      labelNames: ["name", "status"] as const,
      buckets: JOB_DURATION_BUCKETS,
      registers: [this.registry],
    });

    this.cacheOperationsTotal = new Counter({
      name: "cache_operations_total",
      help: "Total number of cache operations",
      labelNames: ["operation", "result"] as const,
      registers: [this.registry],
    });

    this.rateLimitDecisionsTotal = new Counter({
      name: "rate_limit_decisions_total",
      help: "Total number of rate limit decisions",
      labelNames: ["tier", "decision"] as const,
      registers: [this.registry],
    });
  }

  recordHttpRequest(params: HttpRequestMetricParams): void {
    const labels = {
      method: params.method,
      route: params.route,
      status: String(params.status),
    };
    this.httpRequestsTotal.inc(labels);
    if (params.observeDuration !== false) {
      this.httpRequestDurationSeconds.observe(labels, params.durationSeconds);
    }
  }

  incSseConnection(): void {
    this.sseActiveConnections.inc();
    this.sseConnectionsTotal.inc();
  }

  decSseConnection(): void {
    this.sseActiveConnections.dec();
  }

  recordJob(params: JobMetricParams): void {
    const labels = {
      name: params.name,
      status: params.status,
    };
    this.jobsProcessedTotal.inc(labels);
    this.jobDurationSeconds.observe(labels, params.durationSeconds);
  }

  recordCacheOp(params: CacheOpMetricParams): void {
    this.cacheOperationsTotal.inc({
      operation: params.operation,
      result: params.result,
    });
  }

  recordRateLimit(params: RateLimitMetricParams): void {
    this.rateLimitDecisionsTotal.inc({
      tier: params.tier,
      decision: params.decision,
    });
  }

  async render(): Promise<RenderedMetrics> {
    return {
      body: await this.registry.metrics(),
      contentType: this.registry.contentType,
    };
  }
}
