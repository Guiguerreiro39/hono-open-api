import type {
  CacheOpMetricParams,
  HttpRequestMetricParams,
  JobMetricParams,
  MetricsPort,
  RateLimitMetricParams,
  RenderedMetrics,
} from "@/core/ports/metrics";

const PROMETHEUS_TEXT_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export class NoopMetricsAdapter implements MetricsPort {
  recordHttpRequest(_params: HttpRequestMetricParams): void {}

  incSseConnection(): void {}

  decSseConnection(): void {}

  recordJob(_params: JobMetricParams): void {}

  recordCacheOp(_params: CacheOpMetricParams): void {}

  recordRateLimit(_params: RateLimitMetricParams): void {}

  async render(): Promise<RenderedMetrics> {
    return {
      body: "",
      contentType: PROMETHEUS_TEXT_CONTENT_TYPE,
    };
  }
}
