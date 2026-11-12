import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";

import { BadRequestError } from "@/core/errors";
import {
  buildPaginatedResponse,
  decodeCursor,
  decodeTimestampCursor,
  encodeCursor,
  PaginationQuerySchema,
} from "@/core/pagination";

describe("core cursor pagination", () => {
  it("encodes and decodes base64url { v, id } cursors", () => {
    const numCursor = encodeCursor({ v: 1731373415123, id: "550e8400-e29b-41d4-a716-446655440000" });
    expect(numCursor).toMatch(/^[\w-]+$/);
    expect(decodeCursor(numCursor)).toEqual({
      v: 1731373415123,
      id: "550e8400-e29b-41d4-a716-446655440000",
    });

    const strCursor = encodeCursor({ v: "2026-11-12T00:00:00.000Z", id: "abc" });
    expect(decodeCursor(strCursor)).toEqual({
      v: "2026-11-12T00:00:00.000Z",
      id: "abc",
    });
  });

  it("rejects malformed or invalid cursor tokens with BadRequestError", () => {
    const malformedInputs = [
      "",
      "not!base64url",
      "bm90LWpzb24", // "not-json"
      Buffer.from(JSON.stringify({ v: 1 })).toString("base64url"), // missing id
      Buffer.from(JSON.stringify({ id: "1" })).toString("base64url"), // missing v
      Buffer.from(JSON.stringify({ v: 1, id: "" })).toString("base64url"), // empty id
      Buffer.from(JSON.stringify({ v: 1, id: "1", extra: true })).toString("base64url"), // extra field
      Buffer.from(JSON.stringify({ v: true, id: "1" })).toString("base64url"), // boolean v
    ];

    for (const token of malformedInputs) {
      expect(() => decodeCursor(token)).toThrow(BadRequestError);
    }
  });

  it("builds paginated { data, meta } envelopes using the limit + 1 pattern", () => {
    const rows = [
      { id: "id-1", createdAtMs: 300 },
      { id: "id-2", createdAtMs: 200 },
      { id: "id-3", createdAtMs: 100 },
    ];

    const page1 = buildPaginatedResponse(rows, 2, row => ({ v: row.createdAtMs, id: row.id }));
    expect(page1.data).toEqual([
      { id: "id-1", createdAtMs: 300 },
      { id: "id-2", createdAtMs: 200 },
    ]);
    expect(page1.meta.hasMore).toBe(true);
    expect(decodeCursor(page1.meta.nextCursor!)).toEqual({ v: 200, id: "id-2" });

    const page2 = buildPaginatedResponse([rows[2]], 2, row => ({ v: row.createdAtMs, id: row.id }));
    expect(page2.data).toEqual([{ id: "id-3", createdAtMs: 100 }]);
    expect(page2.meta).toEqual({ hasMore: false, nextCursor: null });
  });

  it("validates pagination query limit bounds and defaults", () => {
    expect(PaginationQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(PaginationQuerySchema.parse({ limit: "25", cursor: "abc" })).toEqual({
      limit: 25,
      cursor: "abc",
    });
    expect(() => PaginationQuerySchema.parse({ limit: "0" })).toThrow();
    expect(() => PaginationQuerySchema.parse({ limit: "101" })).toThrow();
  });

  it("decodes valid integer timestamp cursors and rejects non-integer or out-of-Date-range timestamps", () => {
    const valid = encodeCursor({ v: 1731373415123, id: "row-1" });
    expect(decodeTimestampCursor(valid)).toEqual({
      createdAt: new Date(1731373415123),
      id: "row-1",
    });

    const maxBoundary = encodeCursor({ v: 8.64e15, id: "row-max" });
    expect(decodeTimestampCursor(maxBoundary).createdAt.getTime()).toBe(8.64e15);

    const invalidCases = [
      encodeCursor({ v: "2026-11-12T00:00:00.000Z", id: "str" }),
      encodeCursor({ v: 1.5, id: "float" }),
      encodeCursor({ v: 8.64e15 + 1, id: "over-max" }),
      encodeCursor({ v: -8.64e15 - 1, id: "under-min" }),
      encodeCursor({ v: Number.MAX_SAFE_INTEGER, id: "max-safe" }),
      encodeCursor({ v: -Number.MAX_SAFE_INTEGER, id: "min-safe" }),
    ];

    for (const token of invalidCases) {
      expect(() => decodeTimestampCursor(token)).toThrow(BadRequestError);
    }
  });
});
