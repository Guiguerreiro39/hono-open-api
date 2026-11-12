import type { SQL } from "drizzle-orm";
import type { AppDatabase } from "@/infra/db/client";
import type {
  CreateTaskInput,
  ListTasksParams,
  Task,
  TaskRepository,
  TaskScope,
  UpdateTaskInput,
} from "@/modules/tasks/tasks.repository";

import { and, desc, eq, lt, or } from "drizzle-orm";
import { ValidationError } from "@/core/errors";
import { buildPaginatedResponse, decodeTimestampCursor } from "@/core/pagination";
import { normalizeDbError } from "@/infra/db/errors";
import { tasks } from "@/infra/db/schema";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

type TaskRow = typeof tasks.$inferSelect;

function toDomainTask(row: TaskRow): Task {
  return {
    id: row.id,
    name: row.name,
    done: row.done,
    userId: row.userId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function buildIdScopeWhere(id: string, scope?: TaskScope): SQL {
  if (scope?.userId !== undefined) {
    return and(eq(tasks.id, id), eq(tasks.userId, scope.userId))!;
  }
  return eq(tasks.id, id);
}

export function createDrizzleTaskRepository(db: AppDatabase): TaskRepository {
  async function findById(id: string, scope?: TaskScope): Promise<Task | null> {
    try {
      const [row] = await db
        .select()
        .from(tasks)
        .where(buildIdScopeWhere(id, scope))
        .limit(1);

      return row ? toDomainTask(row) : null;
    }
    catch (err) {
      throw normalizeDbError(err);
    }
  }

  return {
    async list(params: ListTasksParams) {
      const limit = params.limit ?? DEFAULT_LIMIT;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
        throw new ValidationError(`Limit must be an integer between 1 and ${MAX_LIMIT}`);
      }

      const conditions: SQL[] = [];
      if (params.userId !== undefined) {
        conditions.push(eq(tasks.userId, params.userId));
      }

      if (params.cursor !== undefined) {
        const { createdAt, id } = decodeTimestampCursor(params.cursor);
        const keyset = or(
          lt(tasks.createdAt, createdAt),
          and(eq(tasks.createdAt, createdAt), lt(tasks.id, id)),
        );
        if (keyset) {
          conditions.push(keyset);
        }
      }

      try {
        const rows = await db
          .select()
          .from(tasks)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(desc(tasks.createdAt), desc(tasks.id))
          .limit(limit + 1);

        const items = rows.map(toDomainTask);
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

    async create(input: CreateTaskInput) {
      try {
        const [row] = await db
          .insert(tasks)
          .values({
            name: input.name,
            done: input.done ?? false,
            userId: input.userId,
          })
          .returning();

        return toDomainTask(row);
      }
      catch (err) {
        throw normalizeDbError(err);
      }
    },

    async update(id: string, input: UpdateTaskInput, scope?: TaskScope) {
      const updates: Partial<typeof tasks.$inferInsert> = {};
      if (input.name !== undefined) {
        updates.name = input.name;
      }
      if (input.done !== undefined) {
        updates.done = input.done;
      }

      if (Object.keys(updates).length === 0) {
        return findById(id, scope);
      }

      try {
        const [row] = await db
          .update(tasks)
          .set(updates)
          .where(buildIdScopeWhere(id, scope))
          .returning();

        return row ? toDomainTask(row) : null;
      }
      catch (err) {
        throw normalizeDbError(err);
      }
    },

    async delete(id: string, scope?: TaskScope) {
      try {
        const deleted = await db
          .delete(tasks)
          .where(buildIdScopeWhere(id, scope))
          .returning({ id: tasks.id });

        return deleted.length > 0;
      }
      catch (err) {
        throw normalizeDbError(err);
      }
    },
  };
}
