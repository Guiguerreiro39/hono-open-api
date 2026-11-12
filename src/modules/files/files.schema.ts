import { z } from "@hono/zod-openapi";

import { createPaginatedResponseSchema, PaginationQuerySchema } from "@/core/pagination";

export const FileStatusSchema = z.enum(["pending", "ready"]);

export const FileSchema = z.object({
  id: z.uuid(),
  userId: z.string(),
  originalName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  checksumSha256: z.string().nullable(),
  status: FileStatusSchema,
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const FileParamsSchema = z.object({
  id: z.uuid(),
});

export const MultipartFileField = z.instanceof(File).openapi({
  type: "string",
  format: "binary",
});

export const UploadFileFormSchema = z.object({
  file: MultipartFileField,
});

export const PresignFileSchema = z.object({
  originalName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1),
  sizeBytes: z.number().int().positive(),
});

export const PresignFileResponseSchema = z.object({
  file: FileSchema,
  uploadUrl: z.string(),
});

export const FileDownloadUrlResponseSchema = z.object({
  url: z.string(),
  expiresInSeconds: z.number().int().positive(),
});

export const ListFilesQuerySchema = PaginationQuerySchema.extend({
  scope: z.enum(["own", "all"]).default("own"),
  userId: z.string().trim().min(1).optional(),
});

export const FileListResponseSchema = createPaginatedResponseSchema(FileSchema);

export type FileDto = z.infer<typeof FileSchema>;
export type PresignFileDto = z.infer<typeof PresignFileSchema>;
export type ListFilesQuery = z.infer<typeof ListFilesQuerySchema>;
