import type { Context, MiddlewareHandler } from "hono";

import type { RateLimiterMiddlewareOptions, RateLimiterPort } from "@/core/ports/rate-limit";
import type { AppBindings, PlatformDeps } from "@/core/types";
import { getConnInfo } from "@hono/node-server/conninfo";

export const RATE_LIMIT_WINDOW_MS = 60_000;
export const AUTH_MUTATION_RATE_LIMIT = 10;
export const GENERAL_API_RATE_LIMIT = 100;
export const UPLOAD_RATE_LIMIT = 10;

export const RATE_LIMIT_EXEMPT_PATHS = new Set([
  "/health",
  "/ready",
  "/metrics",
  "/doc",
  "/reference",
  "/api/auth/open-api/generate-schema",
]);

export function normalizeRateLimitPath(path: string): string {
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }
  return path;
}

export function isExemptRateLimitPath(path: string): boolean {
  return RATE_LIMIT_EXEMPT_PATHS.has(normalizeRateLimitPath(path));
}

export function isAuthMutationRequest(method: string, path: string): boolean {
  if (method.toUpperCase() !== "POST") {
    return false;
  }
  const normalized = normalizeRateLimitPath(path);
  return (
    normalized === "/api/auth/sign-in"
    || normalized.startsWith("/api/auth/sign-in/")
    || normalized === "/api/auth/sign-up"
    || normalized.startsWith("/api/auth/sign-up/")
    || normalized === "/api/auth/request-password-reset"
    || normalized === "/api/auth/reset-password"
    || normalized.startsWith("/api/auth/reset-password/")
    || normalized === "/api/auth/forget-password"
    || normalized.startsWith("/api/auth/forget-password/")
    || normalized === "/api/auth/change-password"
  );
}

function readSocketIp(c: Context): string | undefined {
  try {
    return getConnInfo(c).remote.address;
  }
  catch {
    return undefined;
  }
}

export function resolveClientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwardedFor = c.req.header("x-forwarded-for");
    if (forwardedFor) {
      const clientIp = forwardedFor
        .split(",")
        .map(part => part.trim())
        .find(Boolean);
      if (clientIp) {
        return clientIp;
      }
    }

    const realIp = c.req.header("x-real-ip")?.trim();
    if (realIp) {
      return realIp;
    }
  }

  return readSocketIp(c) ?? "unknown";
}

export function rateLimitByIp(trustProxy: boolean): (c: Context<AppBindings>) => string {
  return c => `ip:${resolveClientIp(c, trustProxy)}`;
}

export function rateLimitByUserOrIp(
  deps: Pick<PlatformDeps, "auth" | "env">,
): (c: Context<AppBindings>) => Promise<string> {
  return async (c) => {
    let user = c.get("user");
    if (!user && (c.req.header("authorization") || c.req.header("cookie"))) {
      const resolved = await deps.auth.getSession(c.req.raw.headers);
      if (resolved && !resolved.user.banned) {
        c.set("user", resolved.user);
        c.set("session", resolved.session);
        user = resolved.user;
      }
    }

    if (user) {
      return `user:${user.id}`;
    }

    return `ip:${resolveClientIp(c, deps.env.TRUST_PROXY)}`;
  };
}

export interface CreateRateLimiterDeps {
  rateLimiter: RateLimiterPort;
  env: Pick<PlatformDeps["env"], "RATE_LIMIT_ENABLED">;
}

export function createRateLimiter(
  deps: CreateRateLimiterDeps,
  options: RateLimiterMiddlewareOptions,
): MiddlewareHandler<AppBindings> {
  return deps.rateLimiter.middleware({
    ...options,
    skip: async (c) => {
      if (!deps.env.RATE_LIMIT_ENABLED || isExemptRateLimitPath(c.req.path)) {
        return true;
      }
      if (options.skip) {
        return options.skip(c);
      }
      return false;
    },
  });
}

export function createAuthRateLimiter(
  deps: Pick<PlatformDeps, "rateLimiter" | "env">,
): MiddlewareHandler<AppBindings> {
  const keyGenerator = rateLimitByIp(deps.env.TRUST_PROXY);

  const authMutationLimiter = createRateLimiter(deps, {
    tier: "auth_mutation",
    limit: AUTH_MUTATION_RATE_LIMIT,
    windowMs: RATE_LIMIT_WINDOW_MS,
    keyGenerator,
  });

  const authGeneralLimiter = createRateLimiter(deps, {
    tier: "api",
    limit: GENERAL_API_RATE_LIMIT,
    windowMs: RATE_LIMIT_WINDOW_MS,
    keyGenerator,
  });

  return (c, next) => {
    if (isAuthMutationRequest(c.req.method, c.req.path)) {
      return authMutationLimiter(c, next);
    }
    return authGeneralLimiter(c, next);
  };
}

export function createApiRateLimiter(
  deps: Pick<PlatformDeps, "rateLimiter" | "auth" | "env">,
  options?: { skip?: (c: Context<AppBindings>) => boolean | Promise<boolean> },
): MiddlewareHandler<AppBindings> {
  return createRateLimiter(deps, {
    tier: "api",
    limit: GENERAL_API_RATE_LIMIT,
    windowMs: RATE_LIMIT_WINDOW_MS,
    keyGenerator: rateLimitByUserOrIp(deps),
    skip: options?.skip,
  });
}

export function createUploadRateLimiter(
  deps: Pick<PlatformDeps, "rateLimiter" | "auth" | "env">,
): MiddlewareHandler<AppBindings> {
  return createRateLimiter(deps, {
    tier: "upload",
    limit: UPLOAD_RATE_LIMIT,
    windowMs: RATE_LIMIT_WINDOW_MS,
    keyGenerator: rateLimitByUserOrIp(deps),
  });
}
