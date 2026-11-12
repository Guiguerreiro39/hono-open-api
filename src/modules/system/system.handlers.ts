import type { healthRoute, readyRoute, rootRoute } from "./system.routes";
import type { ProbeCheck } from "./system.schema";
import type { AppRouteHandler, PlatformDeps } from "@/core/types";
import type { Env } from "@/env";

export interface SystemModuleDeps {
  env: Pick<Env, "APP_NAME" | "READINESS_TIMEOUT_MS">;
  checkDb: PlatformDeps["checkDb"];
  isShuttingDown: PlatformDeps["isShuttingDown"];
}

class ProbeTimeoutError extends Error {
  constructor() {
    super("Readiness check timed out");
    this.name = "ProbeTimeoutError";
  }
}

async function runProbeWithTimeout(
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
          ? "Database readiness check timed out"
          : "Database readiness check failed",
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

    const [dbSettlement] = await Promise.allSettled([
      runProbeWithTimeout(deps.checkDb, deps.env.READINESS_TIMEOUT_MS),
    ]);

    const dbResult = dbSettlement.status === "fulfilled"
      ? dbSettlement.value
      : {
          check: { status: "error" as const, message: "Database readiness check failed" },
          error: dbSettlement.reason,
        };

    if (dbResult.error !== undefined) {
      c.get("logger")?.error({ err: dbResult.error }, "Database readiness probe failed");
    }

    const checks = {
      db: dbResult.check,
      redis: { status: "skipped" as const },
    };

    if (checks.db.status === "error") {
      return c.json({
        status: "unhealthy" as const,
        timestamp,
        checks,
      }, 503);
    }

    return c.json({
      status: "ok" as const,
      timestamp,
      checks,
    }, 200);
  };

  return {
    root,
    health,
    ready,
  };
}
