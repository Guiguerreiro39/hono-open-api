import type { SystemModuleDeps } from "./system.handlers";
import { $ } from "@hono/zod-openapi";

import { createRouter } from "@/core/http";
import { createSystemHandlers } from "./system.handlers";
import { healthRoute, readyRoute, rootRoute } from "./system.routes";

export function createSystemModule(deps: SystemModuleDeps) {
  const handlers = createSystemHandlers(deps);

  return $(
    createRouter()
      .openapi(rootRoute, handlers.root)
      .openapi(healthRoute, handlers.health)
      .openapi(readyRoute, handlers.ready)
      .get("/metrics", handlers.metrics),
  );
}
