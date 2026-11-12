import type { PlatformDeps } from "./core-types";
import { $, createRoute, z } from "@hono/zod-openapi";

import { AUTH_SECURITY, createRequireAuth, createRouter, ErrorResponseSchema } from "./core-types";

const FileRecordSchema = z.object({
  id: z.uuid(),
  originalName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int(),
  status: z.enum(["pending", "ready"]),
});

const MultipartFileField = z.instanceof(File).openapi({
  type: "string",
  format: "binary",
});

const uploadRoute = createRoute({
  method: "post",
  path: "/files",
  tags: ["Files"],
  security: AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "multipart/form-data": {
          schema: z.object({
            file: MultipartFileField,
          }),
        },
      },
    },
  },
  responses: {
    201: { description: "Uploaded file", content: { "application/json": { schema: FileRecordSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponseSchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const presignRoute = createRoute({
  method: "post",
  path: "/files/presign",
  tags: ["Files"],
  security: AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: z.object({
            originalName: z.string().min(1),
            mimeType: z.string().min(1),
            sizeBytes: z.number().int().positive(),
          }),
        },
      },
    },
  },
  responses: {
    201: {
      description: "Presigned upload",
      content: {
        "application/json": {
          schema: z.object({
            file: FileRecordSchema,
            uploadUrl: z.string(),
          }),
        },
      },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const listFilesRoute = createRoute({
  method: "get",
  path: "/files",
  tags: ["Files"],
  security: AUTH_SECURITY,
  request: {
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      cursor: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: "Files list",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(FileRecordSchema),
            meta: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }),
          }),
        },
      },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const completeRoute = createRoute({
  method: "post",
  path: "/files/{id}/complete",
  tags: ["Files"],
  security: AUTH_SECURITY,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: "Completed file", content: { "application/json": { schema: FileRecordSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const urlRoute = createRoute({
  method: "get",
  path: "/files/{id}/url",
  tags: ["Files"],
  security: AUTH_SECURITY,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: "Signed URL", content: { "application/json": { schema: z.object({ url: z.string(), expiresInSeconds: z.number() }) } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const deleteFileRoute = createRoute({
  method: "delete",
  path: "/files/{id}",
  tags: ["Files"],
  security: AUTH_SECURITY,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    204: { description: "Deleted" },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const downloadRoute = createRoute({
  method: "get",
  path: "/files/{id}/download",
  tags: ["Files"],
  security: AUTH_SECURITY,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: {
      description: "Binary download",
      content: {
        "application/octet-stream": {
          schema: { type: "string", format: "binary" },
        },
      },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

export function createFilesModule(deps: Pick<PlatformDeps, "auth" | "storage">) {
  const requireAuth = createRequireAuth(deps.auth);
  const files = new Map<string, { id: string; userId: string; key: string; originalName: string; mimeType: string; sizeBytes: number; status: "pending" | "ready" }>();

  return $(
    createRouter()
      .use("/files", requireAuth)
      .use("/files/*", requireAuth),
  )
    .openapi(uploadRoute, async (c) => {
      const user = c.get("user");
      const { file } = c.req.valid("form");
      const id = crypto.randomUUID();
      const key = `files/${user.id}/${id}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      await deps.storage.put(key, bytes, { contentType: file.type || "application/octet-stream" });

      const record = {
        id,
        userId: user.id,
        key,
        originalName: file.name,
        mimeType: file.type || "application/octet-stream",
        sizeBytes: bytes.byteLength,
        status: "ready" as const,
      };
      files.set(id, record);
      return c.json({
        id: record.id,
        originalName: record.originalName,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        status: record.status,
      }, 201);
    })
    .openapi(presignRoute, async (c) => {
      const user = c.get("user");
      const body = c.req.valid("json");
      const id = crypto.randomUUID();
      const key = `files/${user.id}/${id}`;
      const uploadUrl = await deps.storage.getSignedPutUrl(key, {
        contentType: body.mimeType,
        contentLength: body.sizeBytes,
        expiresInSeconds: 900,
      });
      const record = {
        id,
        userId: user.id,
        key,
        originalName: body.originalName,
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes,
        status: "pending" as const,
      };
      files.set(id, record);
      return c.json({
        file: {
          id: record.id,
          originalName: record.originalName,
          mimeType: record.mimeType,
          sizeBytes: record.sizeBytes,
          status: record.status,
        },
        uploadUrl,
      }, 201);
    })
    .openapi(downloadRoute, async (c) => {
      const user = c.get("user");
      const { id } = c.req.valid("param");
      const rec = files.get(id);
      if (!rec || rec.userId !== user.id) {
        return c.json({
          error: { code: "NOT_FOUND", message: "Not found", requestId: c.get("requestId") ?? "unknown" },
        }, 404);
      }
      const stream = await deps.storage.get(rec.key);
      if (!stream) {
        return c.json({
          error: { code: "NOT_FOUND", message: "Object missing", requestId: c.get("requestId") ?? "unknown" },
        }, 404);
      }
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": rec.mimeType,
          "Content-Disposition": `attachment; filename="${rec.originalName}"`,
        },
      });
    })
    .openapi(listFilesRoute, (c) => {
      const user = c.get("user");
      const data = [...files.values()]
        .filter(f => f.userId === user.id)
        .map(({ id, originalName, mimeType, sizeBytes, status }) => ({ id, originalName, mimeType, sizeBytes, status }));
      return c.json({ data, meta: { nextCursor: null, hasMore: false } }, 200);
    })
    .openapi(completeRoute, (c) => {
      const user = c.get("user");
      const { id } = c.req.valid("param");
      const rec = files.get(id);
      if (!rec || rec.userId !== user.id) {
        return c.json({ error: { code: "NOT_FOUND", message: "Not found", requestId: c.get("requestId") ?? "unknown" } }, 404);
      }
      rec.status = "ready";
      return c.json({
        id: rec.id,
        originalName: rec.originalName,
        mimeType: rec.mimeType,
        sizeBytes: rec.sizeBytes,
        status: rec.status,
      }, 200);
    })
    .openapi(urlRoute, async (c) => {
      const user = c.get("user");
      const { id } = c.req.valid("param");
      const rec = files.get(id);
      if (!rec || rec.userId !== user.id) {
        return c.json({ error: { code: "NOT_FOUND", message: "Not found", requestId: c.get("requestId") ?? "unknown" } }, 404);
      }
      const url = await deps.storage.getSignedGetUrl(rec.key, { expiresInSeconds: 900 });
      return c.json({ url, expiresInSeconds: 900 }, 200);
    })
    .openapi(deleteFileRoute, async (c) => {
      const user = c.get("user");
      const { id } = c.req.valid("param");
      const rec = files.get(id);
      if (!rec || rec.userId !== user.id) {
        return c.json({ error: { code: "NOT_FOUND", message: "Not found", requestId: c.get("requestId") ?? "unknown" } }, 404);
      }
      files.delete(id);
      await deps.storage.delete(rec.key);
      return c.body(null, 204);
    });
}
