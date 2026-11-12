import type { Context, MiddlewareHandler } from "hono";

import type { MetricsPort } from "@/core/ports/metrics";
import type { Env } from "@/env";
import { createHash, timingSafeEqual } from "node:crypto";
import { matchedRoutes, routePath } from "hono/route";

import { NotFoundError, UnauthorizedError } from "@/core/errors";

const EXCLUDED_PATHS = new Set(["/metrics", "/health", "/ready", "/favicon.ico"]);

function isExcludedPath(path: string): boolean {
  if (EXCLUDED_PATHS.has(path)) {
    return true;
  }
  if (path.length > 1 && path.endsWith("/")) {
    return EXCLUDED_PATHS.has(path.slice(0, -1));
  }
  return false;
}

function resolveRouteLabel(c: Context): string {
  const endpoint = matchedRoutes(c).findLast(route => route.method !== "ALL");
  if (endpoint) {
    return endpoint.path;
  }
  if (c.res.status === 404) {
    return "__unmatched__";
  }
  const path = routePath(c, -1);
  return path === "*" ? "__unmatched__" : path;
}

export function metricsMiddleware(metrics: MetricsPort): MiddlewareHandler {
  return async (c, next) => {
    if (isExcludedPath(c.req.path)) {
      return next();
    }

    const startedAt = performance.now();
    try {
      await next();
    }
    finally {
      if (c.res) {
        const durationSeconds = (performance.now() - startedAt) / 1000;
        const contentType = c.res.headers.get("content-type") ?? "";
        const isSse = contentType.toLowerCase().includes("text/event-stream");

        metrics.recordHttpRequest({
          method: c.req.method,
          route: resolveRouteLabel(c),
          status: c.res.status,
          durationSeconds,
          observeDuration: !isSse,
        });
      }
    }
  };
}

function extractBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

function tokensMatch(actual: string, expected: string): boolean {
  const actualHash = createHash("sha256").update(actual, "utf8").digest();
  const expectedHash = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualHash, expectedHash);
}

export function createMetricsEndpointHandler(deps: {
  env: Pick<Env, "METRICS_ENABLED" | "METRICS_TOKEN">;
  metrics: MetricsPort;
}) {
  return async (c: Context) => {
    if (!deps.env.METRICS_ENABLED) {
      throw new NotFoundError("Not found");
    }

    if (deps.env.METRICS_TOKEN !== undefined) {
      const token = extractBearerToken(c.req.header("authorization"));
      if (!token || !tokensMatch(token, deps.env.METRICS_TOKEN)) {
        throw new UnauthorizedError("Unauthorized");
      }
    }

    const { body, contentType } = await deps.metrics.render();
    return c.text(body, 200, {
      "Content-Type": contentType,
    });
  };
}
