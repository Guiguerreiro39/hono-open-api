import type { MetricsPort } from "@/core/ports/metrics";
import type { Env } from "@/env";

import { NoopMetricsAdapter } from "./noop-metrics";
import { PromMetricsAdapter } from "./prom-metrics";

export { NoopMetricsAdapter } from "./noop-metrics";
export { PromMetricsAdapter, type PromMetricsAdapterOptions } from "./prom-metrics";

export function createMetricsAdapter(
  env: Pick<Env, "METRICS_ENABLED" | "NODE_ENV">,
): MetricsPort {
  if (!env.METRICS_ENABLED) {
    return new NoopMetricsAdapter();
  }

  return new PromMetricsAdapter({
    collectDefaultMetrics: env.NODE_ENV !== "test",
  });
}
