import type { PlatformDeps } from "@/core/types";
import { $ } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { timeout } from "hono/timeout";

import { createErrorHandler, notFoundHandler, PayloadTooLargeError } from "@/core/errors";
import { createRouter } from "@/core/http";
import { createHttpLogger } from "@/core/logger";
import { createOpenAPIDocumentConfig, registerOpenAPISecuritySchemes } from "@/core/openapi";
import { createSystemModule } from "@/modules/system/system.index";

const DEFAULT_BODY_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export function createApp(deps: PlatformDeps) {
  const base = $(
    createRouter()
      .use("*", requestId())
      .use("*", createHttpLogger(deps.logger))
      .use("*", cors({ origin: deps.env.CORS_ORIGINS, credentials: true }))
      .use("*", secureHeaders())
      .use("*", bodyLimit({
        maxSize: DEFAULT_BODY_LIMIT_BYTES,
        onError: () => {
          throw new PayloadTooLargeError("Request body exceeds 1 MB limit");
        },
      }))
      .use("*", timeout(DEFAULT_REQUEST_TIMEOUT_MS, () => new HTTPException(408, { message: "Request timeout" }))),
  )
    .notFound(notFoundHandler)
    .onError(createErrorHandler(deps.logger));

  registerOpenAPISecuritySchemes(base);

  return base
    .doc("/doc", () => createOpenAPIDocumentConfig(deps.env.APP_NAME))
    .route("/", createSystemModule(deps));
}

export type AppType = ReturnType<typeof createApp>;
