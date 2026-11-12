import type { Context, MiddlewareHandler } from "hono";

import type { MetricsPort } from "@/core/ports/metrics";
import { matchedRoutes, routePath } from "hono/route";

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
