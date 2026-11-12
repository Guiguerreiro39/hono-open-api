export interface HttpRequestMetricParams {
  method: string;
  route: string;
  status: number;
  durationSeconds: number;
  observeDuration?: boolean;
}

export interface JobMetricParams {
  name: string;
  status: "completed" | "failed";
  durationSeconds: number;
}

export interface CacheOpMetricParams {
  operation: "get" | "set" | "del" | "invalidate";
  result: "hit" | "miss" | "ok" | "error";
}

export interface RateLimitMetricParams {
  tier: string;
  decision: "allowed" | "limited" | "error";
}

export interface RenderedMetrics {
  body: string;
  contentType: string;
}

export interface MetricsPort {
  recordHttpRequest: (params: HttpRequestMetricParams) => void;
  incSseConnection: () => void;
  decSseConnection: () => void;
  recordJob: (params: JobMetricParams) => void;
  recordCacheOp: (params: CacheOpMetricParams) => void;
  recordRateLimit: (params: RateLimitMetricParams) => void;
  render: () => Promise<RenderedMetrics>;
}
