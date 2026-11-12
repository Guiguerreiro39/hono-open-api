import type { healthRoute, readyRoute, rootRoute } from "./system.routes";
import type { ProbeCheck } from "./system.schema";
import type { MetricsPort } from "@/core/ports/metrics";
import type { AppRouteHandler, PlatformDeps } from "@/core/types";
import type { Env } from "@/env";

import { createMetricsEndpointHandler } from "@/core/observability/metrics";

export interface SystemModuleDeps {
  env: Pick<Env, "APP_NAME" | "READINESS_TIMEOUT_MS" | "METRICS_ENABLED" | "METRICS_TOKEN" | "REDIS_URL">;
  checkDb: PlatformDeps["checkDb"];
  checkRedis?: PlatformDeps["checkRedis"];
  isShuttingDown: PlatformDeps["isShuttingDown"];
  metrics: MetricsPort;
}

class ProbeTimeoutError extends Error {
  constructor() {
    super("Readiness check timed out");
    this.name = "ProbeTimeoutError";
  }
}

async function runProbeWithTimeout(
  label: "Database" | "Redis",
  probe: () => Promise<void>,
  timeoutMs: number,
): Promise<{ check: ProbeCheck; error?: unknown }> {
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new ProbeTimeoutError());
        }, timeoutMs);
      }),
    ]);

    return {
      check: {
        status: "ok",
        latencyMs: Math.round(performance.now() - startedAt),
      },
    };
  }
  catch (err) {
    return {
      check: {
        status: "error",
        latencyMs: Math.round(performance.now() - startedAt),
        message: err instanceof ProbeTimeoutError
          ? `${label} readiness check timed out`
          : `${label} readiness check failed`,
      },
      error: err,
    };
  }
  finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export function createSystemHandlers(deps: SystemModuleDeps) {
  const root: AppRouteHandler<typeof rootRoute> = (c) => {
    return c.json({
      name: deps.env.APP_NAME,
      status: "ok" as const,
    }, 200);
  };

  const health: AppRouteHandler<typeof healthRoute> = (c) => {
    return c.json({
      status: "ok" as const,
      timestamp: new Date().toISOString(),
    }, 200);
  };

  const ready: AppRouteHandler<typeof readyRoute> = async (c) => {
    const timestamp = new Date().toISOString();

    if (deps.isShuttingDown()) {
      return c.json({
        status: "unhealthy" as const,
        timestamp,
        checks: {
          db: { status: "skipped" as const, message: "Shutting down" },
          redis: { status: "skipped" as const },
        },
      }, 503);
    }

    const shouldCheckRedis = deps.env.REDIS_URL !== undefined && deps.checkRedis !== undefined;
    const [dbSettlement, redisSettlement] = await Promise.allSettled([
      runProbeWithTimeout("Database", deps.checkDb, deps.env.READINESS_TIMEOUT_MS),
      shouldCheckRedis
        ? runProbeWithTimeout("Redis", deps.checkRedis!, deps.env.READINESS_TIMEOUT_MS)
        : Promise.resolve<{ check: ProbeCheck; error?: unknown }>({
            check: { status: "skipped" },
          }),
    ]);

    const dbResult = dbSettlement.status === "fulfilled"
      ? dbSettlement.value
      : {
          check: { status: "error" as const, message: "Database readiness check failed" },
          error: dbSettlement.reason,
        };

    const redisResult = redisSettlement.status === "fulfilled"
      ? redisSettlement.value
      : {
          check: { status: "error" as const, message: "Redis readiness check failed" },
          error: redisSettlement.reason,
        };

    if (dbResult.error !== undefined) {
      c.get("logger")?.error({ err: dbResult.error }, "Database readiness probe failed");
    }
    if (redisResult.error !== undefined) {
      c.get("logger")?.warn({ err: redisResult.error }, "Redis readiness probe failed");
    }

    const checks = {
      db: dbResult.check,
      redis: redisResult.check,
    };

    if (checks.db.status === "error") {
      return c.json({
        status: "unhealthy" as const,
        timestamp,
        checks,
      }, 503);
    }

    if (checks.redis.status === "error") {
      return c.json({
        status: "degraded" as const,
        timestamp,
        checks,
      }, 200);
    }

    return c.json({
      status: "ok" as const,
      timestamp,
      checks,
    }, 200);
  };

  const metrics = createMetricsEndpointHandler(deps);

  return {
    root,
    health,
    ready,
    metrics,
  };
}
