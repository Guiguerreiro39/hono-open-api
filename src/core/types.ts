import type { OpenAPIHono, RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { Schema } from "hono";
import type { PinoLogger } from "hono-pino";
import type { Logger } from "pino";

import type { Env } from "@/env";

export interface PlatformDeps {
  env: Env;
  logger: Logger;
  checkDb: () => Promise<void>;
  isShuttingDown: () => boolean;
  shutdownSignal: AbortSignal;
}

export interface AppBindings {
  Variables: {
    requestId: string;
    logger: PinoLogger;
  };
}

// eslint-disable-next-line ts/no-empty-object-type
export type AppOpenAPI<S extends Schema = {}> = OpenAPIHono<AppBindings, S>;
export type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, AppBindings>;
