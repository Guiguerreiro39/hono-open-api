import { Buffer } from "node:buffer";
import { z } from "@hono/zod-openapi";

import { BadRequestError } from "./errors";

export const CursorSchema = z.object({
  v: z.union([z.string().min(1), z.number().finite()]),
  id: z.string().min(1),
}).strict();

export type CursorPayload = z.infer<typeof CursorSchema>;

export const PaginationQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export interface PaginatedMeta {
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginatedMeta;
}

const BASE64URL_PATTERN = /^[\w-]+$/;

export function encodeCursor(payload: CursorPayload): string {
  const valid = CursorSchema.parse({ v: payload.v, id: payload.id });
  return Buffer.from(JSON.stringify(valid), "utf8").toString("base64url");
}

export function decodeCursor(token: string): CursorPayload {
  if (!token || !BASE64URL_PATTERN.test(token)) {
    throw new BadRequestError("Invalid pagination cursor", { code: "INVALID_CURSOR" });
  }

  let parsed: unknown;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    parsed = JSON.parse(decoded);
  }
  catch (err) {
    throw new BadRequestError("Invalid pagination cursor", { code: "INVALID_CURSOR", cause: err });
  }

  const result = CursorSchema.safeParse(parsed);
  if (!result.success) {
    throw new BadRequestError("Invalid pagination cursor", { code: "INVALID_CURSOR" });
  }
  return result.data;
}

export interface TimestampCursor {
  createdAt: Date;
  id: string;
}

/** Decodes a keyset cursor whose `v` field is an integer Unix epoch millisecond timestamp within JS `Date` range. */
export function decodeTimestampCursor(token: string): TimestampCursor {
  const decoded = decodeCursor(token);
  if (typeof decoded.v !== "number" || !Number.isInteger(decoded.v)) {
    throw new BadRequestError("Invalid pagination cursor", { code: "INVALID_CURSOR" });
  }

  const createdAt = new Date(decoded.v);
  if (!Number.isFinite(createdAt.getTime())) {
    throw new BadRequestError("Invalid pagination cursor", { code: "INVALID_CURSOR" });
  }

  return {
    createdAt,
    id: decoded.id,
  };
}

export function createPaginatedResponseSchema<T extends z.ZodTypeAny>(itemSchema: T) {
  return z.object({
    data: z.array(itemSchema),
    meta: z.object({
      nextCursor: z.string().nullable(),
      hasMore: z.boolean(),
    }),
  });
}

export function buildPaginatedResponse<T>(
  rows: T[],
  limit: number,
  getCursor: (item: T) => CursorPayload,
): PaginatedResponse<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const lastItem = data[data.length - 1];
  const nextCursor = hasMore && lastItem ? encodeCursor(getCursor(lastItem)) : null;

  return {
    data,
    meta: {
      nextCursor,
      hasMore,
    },
  };
}
