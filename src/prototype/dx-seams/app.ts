import type { PlatformDeps } from "./core-types";
import { $ } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";

import { createAuthModule } from "./auth-module";
import { createRouter } from "./core-types";
import { createFilesModule } from "./files-module";
import { createSystemModule } from "./system-module";
import { createTasksModule } from "./tasks-module";

export function createApp(deps: PlatformDeps) {
  const base = $(
    createRouter()
      .use("*", requestId())
      .use("*", cors({ origin: ["http://localhost:3000"], credentials: true }))
      .use("*", async (c, next) => {
        if (c.req.path === "/reference") {
          return secureHeaders({
            contentSecurityPolicy: {
              defaultSrc: ["'self'"],
              scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
              styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net", "https://fonts.googleapis.com"],
              fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
              imgSrc: ["'self'", "data:", "https:"],
              connectSrc: ["'self'"],
            },
          })(c, next);
        }
        return secureHeaders()(c, next);
      })
      .use("*", bodyLimit({ maxSize: 1024 * 1024 })),
  )
    .doc("/doc", () => ({
      openapi: "3.0.0",
      info: { version: "1.0.0", title: deps.appName },
    }));

  const withDocsAndInfra = $(
    base
      .get(
        "/reference",
        Scalar({
          sources: [
            { url: "/doc", title: "API" },
            { url: "/api/auth/open-api/generate-schema", title: "Auth" },
          ],
          theme: "kepler",
          layout: "classic",
        }),
      )
      .on(["POST", "GET"], "/api/auth/*", c => deps.auth.handler(c.req.raw))
      .on(["PUT", "GET"], "/_storage/*", async (c) => {
        if (!deps.storage.handleSignedRequest) {
          return c.json({ error: { code: "NOT_FOUND", message: "Not found", requestId: c.get("requestId") ?? "unknown" } }, 404);
        }
        return deps.storage.handleSignedRequest(c.req.raw);
      }),
  );

  const apiV1 = createRouter()
    .route("/", createAuthModule(deps))
    .route("/", createTasksModule(deps))
    .route("/", createFilesModule(deps));

  return withDocsAndInfra
    .route("/", createSystemModule(deps))
    .route("/api/v1", apiV1);
}

export type AppType = ReturnType<typeof createApp>;
