import type { OpenAPIHonoOptions, RouteConfig, RouteHandler } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler, Schema } from "hono";
import type { RealtimeEvent } from "@/lib/realtime/pubsub";

import { OpenAPIHono, z } from "@hono/zod-openapi";
import { streamSSE } from "hono/streaming";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  role: string | null;
  banned: boolean;
  banReason: string | null;
  banExpires: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthSession {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  impersonatedBy: string | null;
}

export interface AuthPort {
  getSession: (headers: Headers) => Promise<{ user: AuthUser; session: AuthSession } | null>;
  hasPermission: (params: {
    userId: string;
    role?: string | null;
    permissions: Record<string, string[]>;
  }) => Promise<boolean>;
  updateProfile: (headers: Headers, input: { name?: string; image?: string | null }) => Promise<AuthUser>;
  handler: (req: Request) => Promise<Response>;
}

export interface PubSubPort {
  publish: (topic: string, event: RealtimeEvent) => Promise<void>;
  subscribe: (topic: string, listener: (event: RealtimeEvent) => void | Promise<void>) => Promise<() => Promise<void>>;
}

export interface StoragePort {
  put: (key: string, body: Uint8Array, opts?: { contentType?: string }) => Promise<void>;
  get: (key: string, opts?: { range?: { start: number; end: number } }) => Promise<ReadableStream<Uint8Array> | null>;
  delete: (key: string) => Promise<void>;
  getSignedPutUrl: (key: string, opts: { contentType: string; contentLength: number; expiresInSeconds: number }) => Promise<string>;
  getSignedGetUrl: (key: string, opts: { expiresInSeconds: number }) => Promise<string>;
  handleSignedRequest?: (req: Request) => Promise<Response>;
}

export interface PlatformDeps {
  appName: string;
  auth: AuthPort;
  pubsub: PubSubPort;
  storage: StoragePort;
  isShuttingDown: () => boolean;
  shutdownSignal: AbortSignal;
}

export interface AppBindings {
  Variables: {
    requestId: string;
    user: AuthUser;
    session: AuthSession;
  };
}

// eslint-disable-next-line ts/no-empty-object-type
export type AppOpenAPI<S extends Schema = {}> = OpenAPIHono<AppBindings, S>;
export type AppRouteHandler<R extends RouteConfig> = RouteHandler<R, AppBindings>;

export const AUTH_SECURITY: Array<Record<string, string[]>> = [
  { bearerAuth: [] },
  { cookieAuth: [] },
];

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});

export const validationHook: OpenAPIHonoOptions<AppBindings>["defaultHook"] = (result, c) => {
  if (!result.success) {
    return c.json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        requestId: c.get("requestId") ?? "unknown",
        details: result.error.issues,
      },
    }, 422);
  }
};

export function createRouter(defaultHook: OpenAPIHonoOptions<AppBindings>["defaultHook"] = validationHook) {
  return new OpenAPIHono<AppBindings>({
    strict: false,
    defaultHook,
  });
}

export function createRequireAuth(auth: AuthPort): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const res = await auth.getSession(c.req.raw.headers);
    if (!res) {
      return c.json({
        error: { code: "UNAUTHORIZED", message: "Unauthorized", requestId: c.get("requestId") ?? "unknown" },
      }, 401);
    }
    if (res.user.banned) {
      return c.json({
        error: { code: "FORBIDDEN", message: "Banned", requestId: c.get("requestId") ?? "unknown" },
      }, 403);
    }
    c.set("user", res.user);
    c.set("session", res.session);
    return next();
  };
}

export async function createLiveQueryStream<T>(options: {
  c: Context<AppBindings>;
  pubsub: PubSubPort;
  topic: string | string[];
  fetcher: () => Promise<T>;
  shutdownSignal: AbortSignal;
}): Promise<Response> {
  const { c, pubsub, topic, fetcher, shutdownSignal } = options;
  const topics = Array.isArray(topic) ? topic : [topic];

  let isClosed = false;
  const unsubs: Array<() => Promise<void>> = [];
  for (const t of topics) {
    unsubs.push(await pubsub.subscribe(t, () => {}));
  }

  return streamSSE(c, async (stream) => {
    const cleanup = () => {
      if (isClosed) return;
      isClosed = true;
      void Promise.allSettled(unsubs.map(u => u()));
    };
    stream.onAbort(cleanup);
    shutdownSignal.addEventListener("abort", cleanup, { once: true });

    const data = await fetcher();
    await stream.writeSSE({
      event: "init",
      data: JSON.stringify(data),
    });

    while (!isClosed && !shutdownSignal.aborted) {
      await stream.sleep(50);
    }
  });
}
