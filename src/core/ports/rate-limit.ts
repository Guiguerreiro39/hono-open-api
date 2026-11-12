import type { Context, MiddlewareHandler } from "hono";

import type { AppBindings } from "@/core/types";

export type RateLimitTier = "auth_mutation" | "api" | "upload" | (string & {});

export interface RateLimitPolicy {
  tier: RateLimitTier;
  limit: number;
  windowMs: number;
}

export interface RateLimitConsumeResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetTime?: Date;
  failedOpen?: boolean;
}

export interface RateLimiterMiddlewareOptions extends RateLimitPolicy {
  keyGenerator: (c: Context<AppBindings>) => string | Promise<string>;
  skip?: (c: Context<AppBindings>) => boolean | Promise<boolean>;
}

export interface RateLimiterPort {
  consume: (policy: RateLimitPolicy, key: string) => Promise<RateLimitConsumeResult>;
  middleware: (options: RateLimiterMiddlewareOptions) => MiddlewareHandler<AppBindings>;
  resetKey: (tier: RateLimitTier, key: string) => Promise<void>;
  close: () => Promise<void>;
}
