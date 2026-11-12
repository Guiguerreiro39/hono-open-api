import type { AuthModuleDeps } from "./auth.handlers";
import { $ } from "@hono/zod-openapi";

import { requireAuth } from "@/core/auth/middlewares";
import { createRouter } from "@/core/http";
import { createAuthHandlers } from "./auth.handlers";
import { getMeRoute, patchMeRoute } from "./auth.routes";

export function createAuthModule(deps: AuthModuleDeps) {
  const handlers = createAuthHandlers(deps);

  return $(
    createRouter().use("/me", requireAuth(deps.auth)),
  )
    .openapi(getMeRoute, handlers.getMe)
    .openapi(patchMeRoute, handlers.patchMe);
}
