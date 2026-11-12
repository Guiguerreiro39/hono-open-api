import type { SQL } from "drizzle-orm";
import type { AppDatabase } from "@/infra/db/client";
import type {
  CreateFileInput,
  FileRecord,
  FileRepository,
  FileScope,
  ListFilesParams,
  UpdateFileInput,
} from "@/modules/files/files.repository";

import { and, asc, desc, eq, isNotNull, lt, lte, or } from "drizzle-orm";
import { BadRequestError, ValidationError } from "@/core/errors";
import { buildPaginatedResponse, decodeCursor } from "@/core/pagination";
import { normalizeDbError } from "@/infra/db/errors";
import { files } from "@/infra/db/schema";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_PRUNE_FIND_LIMIT = 100;

type FileRow = typeof files.$inferSelect;

function toDomainFile(row: FileRow): FileRecord {
  return {
    id: row.id,
    userId: row.userId,
    key: row.key,
    originalName: row.originalName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    checksumSha256: row.checksumSha256 ?? null,
    status: row.status,
    expiresAt: row.expiresAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function buildIdScopeWhere(id: string, scope?: FileScope): SQL {
  if (scope?.userId !== undefined) {
    return and(eq(files.id, id), eq(files.userId, scope.userId))!;
  }
  return eq(files.id, id);
}

export function createDrizzleFileRepository(db: AppDatabase): FileRepository {
  async function findById(id: string, scope?: FileScope): Promise<FileRecord | null> {
    try {
      const [row] = await db
        .select()
        .from(files)
        .where(buildIdScopeWhere(id, scope))
        .limit(1);

      return row ? toDomainFile(row) : null;
    }
    catch (err) {
      throw normalizeDbError(err);
    }
  }

  return {
    async list(params: ListFilesParams) {
      const limit = params.limit ?? DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new ValidationError(`Limit must be an integer between 1 and ${MAX_LIMIT}`);
      }

      const status = params.status ?? "ready";
      const conditions: SQL[] = [eq(files.status, status)];

      if (params.userId !== undefined) {
        conditions.push(eq(files.userId, params.userId));
      }

      if (params.cursor !== undefined) {
        const decoded = decodeCursor(params.cursor);
        if (typeof decoded.v !== "number" || !Number.isInteger(decoded.v)) {
          throw new BadRequestError("Invalid pagination cursor", { code: "INVALID_CURSOR" });
        }
        const cursorDate = new Date(decoded.v);
        const keyset = or(
          lt(files.createdAt, cursorDate),
          and(eq(files.createdAt, cursorDate), lt(files.id, decoded.id)),
        );
        if (keyset) {
          conditions.push(keyset);
        }
      }

      try {
        const rows = await db
          .select()
          .from(files)
          .where(and(...conditions))
          .orderBy(desc(files.createdAt), desc(files.id))
          .limit(limit + 1);

        const items = rows.map(toDomainFile);
        return buildPaginatedResponse(items, limit, item => ({
          v: item.createdAt.getTime(),
          id: item.id,
        }));
      }
      catch (err) {
        throw normalizeDbError(err);
      }
    },

    findById,

    async create(input: CreateFileInput) {
      try {
        const [row] = await db
          .insert(files)
          .values({
            ...(input.id !== undefined ? { id: input.id } : {}),
            userId: input.userId,
            key: input.key,
            originalName: input.originalName,
            mimeType: input.mimeType,
            sizeBytes: input.sizeBytes,
            checksumSha256: input.checksumSha256 ?? null,
            status: input.status,
            expiresAt: input.expiresAt ?? null,
          })
          .returning();

        return toDomainFile(row);
      }
      catch (err) {
        throw normalizeDbError(err);
      }
    },

    async update(id: string, input: UpdateFileInput, scope?: FileScope) {
      const updates: Partial<typeof files.$inferInsert> = {};
      if (input.mimeType !== undefined) {
        updates.mimeType = input.mimeType;
      }
      if (input.sizeBytes !== undefined) {
        updates.sizeBytes = input.sizeBytes;
      }
      if (input.checksumSha256 !== undefined) {
        updates.checksumSha256 = input.checksumSha256;
      }
      if (input.status !== undefined) {
        updates.status = input.status;
      }
      if (input.expiresAt !== undefined) {
        updates.expiresAt = input.expiresAt;
      }

      if (Object.keys(updates).length === 0) {
        return findById(id, scope);
      }

      try {
        const [row] = await db
          .update(files)
          .set(updates)
          .where(buildIdScopeWhere(id, scope))
          .returning();

        return row ? toDomainFile(row) : null;
      }
      catch (err) {
        throw normalizeDbError(err);
      }
    },

    async delete(id: string, scope?: FileScope) {
      try {
        const deleted = await db
          .delete(files)
          .where(buildIdScopeWhere(id, scope))
          .returning({ id: files.id });

        return deleted.length > 0;
      }
      catch (err) {
        throw normalizeDbError(err);
      }
    },

    async findExpiredPending(now = new Date(), limit = DEFAULT_PRUNE_FIND_LIMIT) {
      if (!Number.isInteger(limit) || limit < 1) {
        throw new ValidationError("Limit must be a positive integer");
      }

      try {
        const rows = await db
          .select()
          .from(files)
          .where(and(
            eq(files.status, "pending"),
            isNotNull(files.expiresAt),
            lte(files.expiresAt, now),
          ))
          .orderBy(asc(files.expiresAt), asc(files.id))
          .limit(limit);

        return rows.map(toDomainFile);
      }
      catch (err) {
        throw normalizeDbError(err);
      }
    },

    async deleteExpiredPending(now = new Date()) {
      try {
        const rows = await db
          .delete(files)
          .where(and(
            eq(files.status, "pending"),
            isNotNull(files.expiresAt),
            lte(files.expiresAt, now),
          ))
          .returning();

        return rows.map(toDomainFile);
      }
      catch (err) {
        throw normalizeDbError(err);
      }
    },
  };
}
