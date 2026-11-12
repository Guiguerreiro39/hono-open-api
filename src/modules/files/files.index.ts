import type { FilesServiceDeps } from "./files.service";
import type { PlatformDeps } from "@/core/types";
import { $ } from "@hono/zod-openapi";

import { requireAuth } from "@/core/auth/middlewares";
import { createRouter } from "@/core/http";
import { createUploadRateLimiter } from "@/core/rate-limit";
import { createFilesHandlers } from "./files.handlers";
import {
  completeFileRoute,
  deleteFileRoute,
  downloadFileRoute,
  getFileUrlRoute,
  listFilesRoute,
  presignFileRoute,
  uploadFileRoute,
} from "./files.routes";
import { createFilesService } from "./files.service";

export type FilesModuleDeps = FilesServiceDeps & Pick<PlatformDeps, "rateLimiter" | "env">;

export function createFilesModule(deps: FilesModuleDeps) {
  const authMiddleware = requireAuth(deps.auth);
  const uploadRateLimiter = createUploadRateLimiter(deps);
  const service = createFilesService(deps);
  const handlers = createFilesHandlers(service);

  return $(
    createRouter()
      .use("/files", async (c, next) => {
        if (c.req.method === "POST") {
          return uploadRateLimiter(c, next);
        }
        return next();
      })
      .use("/files/presign", async (c, next) => {
        if (c.req.method === "POST") {
          return uploadRateLimiter(c, next);
        }
        return next();
      })
      .use("/files", authMiddleware)
      .use("/files/*", authMiddleware),
  )
    .openapi(listFilesRoute, handlers.listFiles)
    .openapi(uploadFileRoute, handlers.uploadFile)
    .openapi(presignFileRoute, handlers.presignFile)
    .openapi(completeFileRoute, handlers.completeFile)
    .openapi(downloadFileRoute, handlers.downloadFile)
    .openapi(getFileUrlRoute, handlers.getFileUrl)
    .openapi(deleteFileRoute, handlers.deleteFile);
}
