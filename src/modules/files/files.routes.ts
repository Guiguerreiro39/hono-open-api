import { createRoute } from "@hono/zod-openapi";

import { createErrorResponses } from "@/core/errors";
import { AUTH_SECURITY } from "@/core/openapi";
import {
  FileDownloadUrlResponseSchema,
  FileListResponseSchema,
  FileParamsSchema,
  FileSchema,
  ListFilesQuerySchema,
  PresignFileResponseSchema,
  PresignFileSchema,
  UploadFileFormSchema,
} from "./files.schema";

export const uploadFileRoute = createRoute({
  method: "post",
  path: "/files",
  tags: ["Files"],
  security: AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "multipart/form-data": {
          schema: UploadFileFormSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Uploaded file",
      content: {
        "application/json": {
          schema: FileSchema,
        },
      },
    },
    ...createErrorResponses(401, 403, 413, 422, 429),
  },
});

export const presignFileRoute = createRoute({
  method: "post",
  path: "/files/presign",
  tags: ["Files"],
  security: AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: PresignFileSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Presigned upload initialized",
      content: {
        "application/json": {
          schema: PresignFileResponseSchema,
        },
      },
    },
    ...createErrorResponses(401, 403, 413, 422, 429),
  },
});

export const completeFileRoute = createRoute({
  method: "post",
  path: "/files/{id}/complete",
  tags: ["Files"],
  security: AUTH_SECURITY,
  request: {
    params: FileParamsSchema,
  },
  responses: {
    200: {
      description: "Completed file upload",
      content: {
        "application/json": {
          schema: FileSchema,
        },
      },
    },
    ...createErrorResponses(401, 403, 404, 409, 413, 422),
  },
});

export const listFilesRoute = createRoute({
  method: "get",
  path: "/files",
  tags: ["Files"],
  security: AUTH_SECURITY,
  request: {
    query: ListFilesQuerySchema,
  },
  responses: {
    200: {
      description: "Paginated ready files",
      content: {
        "application/json": {
          schema: FileListResponseSchema,
        },
      },
    },
    ...createErrorResponses(400, 401, 403, 422),
  },
});

export const downloadFileRoute = createRoute({
  method: "get",
  path: "/files/{id}/download",
  tags: ["Files"],
  security: AUTH_SECURITY,
  request: {
    params: FileParamsSchema,
  },
  responses: {
    200: {
      description: "Binary file stream",
      content: {
        "application/octet-stream": {
          schema: { type: "string", format: "binary" },
        },
      },
    },
    ...createErrorResponses(401, 403, 404, 409, 422),
  },
});

export const getFileUrlRoute = createRoute({
  method: "get",
  path: "/files/{id}/url",
  tags: ["Files"],
  security: AUTH_SECURITY,
  request: {
    params: FileParamsSchema,
  },
  responses: {
    200: {
      description: "Signed download URL",
      content: {
        "application/json": {
          schema: FileDownloadUrlResponseSchema,
        },
      },
    },
    ...createErrorResponses(401, 403, 404, 409, 422),
  },
});

export const deleteFileRoute = createRoute({
  method: "delete",
  path: "/files/{id}",
  tags: ["Files"],
  security: AUTH_SECURITY,
  request: {
    params: FileParamsSchema,
  },
  responses: {
    204: {
      description: "File deleted",
    },
    ...createErrorResponses(401, 403, 404, 422),
  },
});
