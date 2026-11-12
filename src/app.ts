import type { PlatformDeps } from "@/core/types";
import { $ } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { timeout } from "hono/timeout";

import { createErrorHandler, getRequestId, notFoundHandler, PayloadTooLargeError } from "@/core/errors";
import { createRouter } from "@/core/http";
import { createHttpLogger } from "@/core/logger";
import { createOpenAPIDocumentConfig, registerOpenAPISecuritySchemes } from "@/core/openapi";
import { createAuthModule } from "@/modules/auth/auth.index";
import { createSystemModule } from "@/modules/system/system.index";

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

function isSignedStoragePath(path: string): boolean {
  return path === "/_storage" || path.startsWith("/_storage/");
}

const defaultBodyLimit = bodyLimit({
  maxSize: DEFAULT_BODY_LIMIT_BYTES,
  onError: () => {
    throw new PayloadTooLargeError("Request body exceeds 1 MB limit");
  },
});

const defaultTimeout = timeout(
  DEFAULT_REQUEST_TIMEOUT_MS,
  () => new HTTPException(408, { message: "Request timeout" }),
);

const defaultSecureHeaders = secureHeaders();
const referenceSecureHeaders = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
    styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com"],
    fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
    imgSrc: ["'self'", "data:", "https:"],
    connectSrc: ["'self'"],
  },
});

export function createApp(deps: PlatformDeps) {
  const base = $(
    createRouter()
      .use("*", requestId())
      .use("*", createHttpLogger(deps.logger))
      .use("*", cors({ origin: deps.env.CORS_ORIGINS, credentials: true }))
      .use("*", async (c, next) => {
        if (c.req.path === "/reference") {
          return referenceSecureHeaders(c, next);
        }
        return defaultSecureHeaders(c, next);
      })
      .use("*", async (c, next) => {
        if (isSignedStoragePath(c.req.path)) {
          return next();
        }
        return defaultBodyLimit(c, next);
      })
      .use("*", async (c, next) => {
        if (isSignedStoragePath(c.req.path)) {
          return next();
        }
        return defaultTimeout(c, next);
      }),
  )
    .notFound(notFoundHandler)
    .onError(createErrorHandler(deps.logger));

  registerOpenAPISecuritySchemes(base);

  const withDocsAndAuth = $(
    base
      .doc("/doc", () => createOpenAPIDocumentConfig(deps.env.APP_NAME))
      .get(
        "/reference",
        Scalar({
          pageTitle: deps.env.APP_NAME,
          theme: "kepler",
          layout: "classic",
          sources: [
            { url: "/doc", title: "API" },
            { url: "/api/auth/open-api/generate-schema", title: "Auth" },
          ],
        }),
      )
      .on(["POST", "GET"], "/api/auth/*", c => deps.auth.handler(c.req.raw))
      .on(["PUT", "GET"], "/_storage/*", async (c) => {
        if (!deps.storage.handleSignedRequest) {
          return c.json({
            error: {
              code: "NOT_FOUND",
              message: "Not found",
              requestId: getRequestId(c),
            },
          }, 404);
        }
        return deps.storage.handleSignedRequest(c.req.raw, {
          requestId: getRequestId(c),
        });
      }),
  );

  const apiV1 = createRouter()
    .route("/", createAuthModule(deps));

  return withDocsAndAuth
    .route("/", createSystemModule(deps))
    .route("/api/v1", apiV1);
}

export type AppType = ReturnType<typeof createApp>;
