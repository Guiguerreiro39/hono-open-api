import type { OpenAPIHono, RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { Schema } from "hono";
import type { PinoLogger } from "hono-pino";
import type { Logger } from "pino";

import type { AuthPort, AuthSession, AuthUser } from "@/core/ports/auth";
import type { CachePort } from "@/core/ports/cache";
import type { MetricsPort } from "@/core/ports/metrics";
import type { PubSubPort } from "@/core/ports/pubsub";
import type { QueuePort } from "@/core/ports/queue";
import type { RateLimiterPort } from "@/core/ports/rate-limit";
import type { StoragePort } from "@/core/ports/storage";
import type { Env } from "@/env";

export interface PlatformDeps {
  env: Env;
  logger: Logger;
  metrics: MetricsPort;
  auth: AuthPort;
  cache: CachePort;
  rateLimiter: RateLimiterPort;
  queue: QueuePort;
  pubsub: PubSubPort;
  storage: StoragePort;
  checkDb: () => Promise<void>;
  checkRedis?: () => Promise<void>;
  isShuttingDown?: () => boolean;
  shutdownSignal?: AbortSignal;
}

export interface AppBindings {
  Variables: {
    requestId: string;
    logger: PinoLogger;
    user: AuthUser;
    session: AuthSession;
  };
}

// eslint-disable-next-line ts/no-empty-object-type
export type AppOpenAPI<S extends Schema = {}> = OpenAPIHono<AppBindings, S>;
export type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, AppBindings>;
