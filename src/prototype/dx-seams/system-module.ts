import type { PlatformDeps } from "./core-types";
import { $, createRoute, z } from "@hono/zod-openapi";

import { createRouter } from "./core-types";

const rootRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["System"],
  responses: {
    200: {
      description: "Starter metadata",
      content: {
        "application/json": {
          schema: z.object({ name: z.string(), status: z.literal("ok") }),
        },
      },
    },
  },
});

const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["System"],
  responses: {
    200: {
      description: "Liveness probe",
      content: {
        "application/json": {
          schema: z.object({ status: z.literal("ok"), timestamp: z.iso.datetime() }),
        },
      },
    },
  },
});

const readyRoute = createRoute({
  method: "get",
  path: "/ready",
  tags: ["System"],
  responses: {
    200: {
      description: "Readiness probe OK",
      content: {
        "application/json": {
          schema: z.object({ status: z.enum(["ok", "degraded"]), timestamp: z.iso.datetime() }),
        },
      },
    },
    503: {
      description: "Readiness probe unhealthy",
      content: {
        "application/json": {
          schema: z.object({ status: z.literal("unhealthy"), timestamp: z.iso.datetime() }),
        },
      },
    },
  },
});

export function createSystemModule(deps: Pick<PlatformDeps, "appName" | "isShuttingDown">) {
  const router = createRouter()
    .openapi(rootRoute, c => c.json({ name: deps.appName, status: "ok" as const }, 200))
    .openapi(healthRoute, c => c.json({ status: "ok" as const, timestamp: new Date().toISOString() }, 200))
    .openapi(readyRoute, (c) => {
      if (deps.isShuttingDown()) {
        return c.json({ status: "unhealthy" as const, timestamp: new Date().toISOString() }, 503);
      }
      return c.json({ status: "ok" as const, timestamp: new Date().toISOString() }, 200);
    });

  return $(
    router.get("/metrics", c => c.text("# TYPE up gauge\nup 1\n", 200)),
  );
}
