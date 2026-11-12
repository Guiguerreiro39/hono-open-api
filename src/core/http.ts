import type { OpenAPIHonoOptions } from "@hono/zod-openapi";

import type { AppBindings } from "./types";
import { OpenAPIHono } from "@hono/zod-openapi";

import { defaultHook } from "./errors";

export function createRouter(
  hook: OpenAPIHonoOptions<AppBindings>["defaultHook"] = defaultHook,
) {
  return new OpenAPIHono<AppBindings>({
    strict: false,
    defaultHook: hook,
  });
}
