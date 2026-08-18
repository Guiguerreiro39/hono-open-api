import type { Schema } from "hono";

import type { AppBindings, AppOpenAPI } from "./types";
import { OpenAPIHono } from "@hono/zod-openapi";
import { requestId } from "hono/request-id";
import { notFound, onError, serveEmojiFavicon } from "stoker/middlewares";

import { defaultHook } from "stoker/openapi";

import { requireAuth } from "@/middlewares/auth";
import { pinoLogger } from "@/middlewares/pino-logger";

export function createRouter() {
  return new OpenAPIHono<AppBindings>({
    strict: false,
    defaultHook,
  });
}

export default function createApp() {
  const app = createRouter();
  app.use(requestId())
    .use(serveEmojiFavicon("📝"))
    .use(pinoLogger());

  app.notFound(notFound);
  app.onError(onError);
  return app;
}

export function createTestApp<S extends Schema>(router: AppOpenAPI<S>) {
  const app = createApp();
  app.use("/tasks/*", requireAuth);
  app.use("/tasks", requireAuth);
  app.use("/users/*", requireAuth);
  app.use("/users", requireAuth);
  return app.route("/", router);
}
