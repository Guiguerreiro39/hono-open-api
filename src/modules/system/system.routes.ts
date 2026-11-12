import { createRoute } from "@hono/zod-openapi";

import {
  HealthResponseSchema,
  ReadyOkResponseSchema,
  ReadyUnhealthyResponseSchema,
  RootResponseSchema,
} from "./system.schema";

export const rootRoute = createRoute({
  method: "get",
  path: "/",
  tags: ["System"],
  responses: {
    200: {
      description: "Starter metadata",
      content: {
        "application/json": {
          schema: RootResponseSchema,
        },
      },
    },
  },
});

export const healthRoute = createRoute({
  method: "get",
  path: "/health",
  tags: ["System"],
  responses: {
    200: {
      description: "Liveness probe",
      content: {
        "application/json": {
          schema: HealthResponseSchema,
        },
      },
    },
  },
});

export const readyRoute = createRoute({
  method: "get",
  path: "/ready",
  tags: ["System"],
  responses: {
    200: {
      description: "Readiness probe healthy",
      content: {
        "application/json": {
          schema: ReadyOkResponseSchema,
        },
      },
    },
    503: {
      description: "Readiness probe unhealthy",
      content: {
        "application/json": {
          schema: ReadyUnhealthyResponseSchema,
        },
      },
    },
  },
});
