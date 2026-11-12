import type { Task, TaskRepository } from "@/modules/tasks/tasks.repository";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BadRequestError } from "@/core/errors";
import { encodeCursor } from "@/core/pagination";

export interface TaskRepositoryContractContext {
  repository: TaskRepository;
  createUser: (label?: string) => Promise<string>;
  deleteUser: (userId: string) => Promise<void>;
  cleanup: () => Promise<void>;
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerTaskRepositoryContractSuite(
  name: string,
  createContext: () => Promise<TaskRepositoryContractContext>,
): void {
  describe(`TaskRepository contract (${name})`, () => {
    let ctx: TaskRepositoryContractContext;

    beforeEach(async () => {
      ctx = await createContext();
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    it("supports create, findById, update, and delete CRUD lifecycle", async () => {
      const userId = await ctx.createUser("owner");

      const created = await ctx.repository.create({
        name: "Write contract tests",
        userId,
      });

      expect(created.id).toMatch(UUID_V4_PATTERN);
      expect(created.name).toBe("Write contract tests");
      expect(created.done).toBe(false);
      expect(created.userId).toBe(userId);
      expect(created.createdAt).toBeInstanceOf(Date);
      expect(created.updatedAt).toBeInstanceOf(Date);

      const found = await ctx.repository.findById(created.id);
      expect(found).toEqual(created);

      const missing = await ctx.repository.findById(crypto.randomUUID());
      expect(missing).toBeNull();

      await new Promise(resolve => setTimeout(resolve, 5));
      const updated = await ctx.repository.update(created.id, { done: true });
      expect(updated).not.toBeNull();
      expect(updated?.name).toBe("Write contract tests");
      expect(updated?.done).toBe(true);
      expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());

      const renamed = await ctx.repository.update(created.id, { name: "Updated title" });
      expect(renamed?.name).toBe("Updated title");
      expect(renamed?.done).toBe(true);

      const missingUpdate = await ctx.repository.update(crypto.randomUUID(), { done: false });
      expect(missingUpdate).toBeNull();

      const deleted = await ctx.repository.delete(created.id);
      expect(deleted).toBe(true);
      expect(await ctx.repository.findById(created.id)).toBeNull();
      expect(await ctx.repository.delete(created.id)).toBe(false);
    });

    it("enforces ownership scoping on list, findById, update, and delete", async () => {
      const aliceId = await ctx.createUser("alice");
      const bobId = await ctx.createUser("bob");

      const aliceTask = await ctx.repository.create({ name: "Alice task", userId: aliceId });
      const bobTask = await ctx.repository.create({ name: "Bob task", userId: bobId, done: true });

      // Scoped findById hides foreign tasks, unscoped returns both
      expect(await ctx.repository.findById(aliceTask.id, { userId: aliceId })).toEqual(aliceTask);
      expect(await ctx.repository.findById(aliceTask.id, { userId: bobId })).toBeNull();
      expect(await ctx.repository.findById(aliceTask.id)).toEqual(aliceTask);

      // Scoped update ignores foreign tasks without mutating
      expect(await ctx.repository.update(aliceTask.id, { done: true }, { userId: bobId })).toBeNull();
      expect((await ctx.repository.findById(aliceTask.id))?.done).toBe(false);

      // Unscoped update succeeds on any task
      const adminUpdated = await ctx.repository.update(aliceTask.id, { done: true });
      expect(adminUpdated?.done).toBe(true);

      // Scoped delete ignores foreign tasks without deleting
      expect(await ctx.repository.delete(bobTask.id, { userId: aliceId })).toBe(false);
      expect(await ctx.repository.findById(bobTask.id)).not.toBeNull();

      // List scoping
      const aliceList = await ctx.repository.list({ userId: aliceId });
      expect(aliceList.data.map(t => t.id)).toEqual([aliceTask.id]);

      const allList = await ctx.repository.list({});
      expect(allList.data.map(t => t.id).sort()).toEqual([aliceTask.id, bobTask.id].sort());

      // Unscoped delete removes foreign task
      expect(await ctx.repository.delete(bobTask.id)).toBe(true);
      expect(await ctx.repository.findById(bobTask.id)).toBeNull();
    });

    it("paginates deterministically with base64url cursors including same-ms tie-breaking and mutations", async () => {
      const userId = await ctx.createUser("paginator");

      // Insert rapidly so multiple rows can share the exact same millisecond timestamp
      const created: Task[] = [];
      for (let i = 0; i < 5; i++) {
        created.push(await ctx.repository.create({ name: `Task ${i}`, userId }));
      }

      const page1 = await ctx.repository.list({ userId, limit: 2 });
      expect(page1.data).toHaveLength(2);
      expect(page1.meta.hasMore).toBe(true);
      expect(page1.meta.nextCursor).toBeTruthy();

      const page2 = await ctx.repository.list({
        userId,
        limit: 2,
        cursor: page1.meta.nextCursor ?? undefined,
      });
      expect(page2.data).toHaveLength(2);
      expect(page2.meta.hasMore).toBe(true);
      expect(page2.meta.nextCursor).toBeTruthy();

      const page3 = await ctx.repository.list({
        userId,
        limit: 2,
        cursor: page2.meta.nextCursor ?? undefined,
      });
      expect(page3.data).toHaveLength(1);
      expect(page3.meta).toEqual({ hasMore: false, nextCursor: null });

      const visitedIds = [...page1.data, ...page2.data, ...page3.data].map(t => t.id);
      expect(new Set(visitedIds).size).toBe(5);
      expect(visitedIds.slice().sort()).toEqual(created.map(t => t.id).sort());

      // Same-millisecond tie-breaking with limit=1 visits all 5 without skips or duplicates
      const singleSteps: string[] = [];
      let cursor: string | undefined;
      for (let step = 0; step < 10; step++) {
        const res = await ctx.repository.list({ userId, limit: 1, cursor });
        singleSteps.push(...res.data.map(t => t.id));
        if (!res.meta.hasMore || !res.meta.nextCursor) {
          break;
        }
        cursor = res.meta.nextCursor;
      }
      expect(singleSteps).toEqual(visitedIds);

      // Mutating before fetching page 2 (inserting a newer row & deleting a page 1 row) keeps cursor stable
      await new Promise(resolve => setTimeout(resolve, 5));
      const newest = await ctx.repository.create({ name: "Newest after page1", userId });
      await ctx.repository.delete(page1.data[0]!.id);

      const firstAfterMutation = await ctx.repository.list({ userId, limit: 1 });
      expect(firstAfterMutation.data[0]?.id).toBe(newest.id);

      const stablePage2 = await ctx.repository.list({
        userId,
        limit: 2,
        cursor: page1.meta.nextCursor ?? undefined,
      });
      expect(stablePage2.data.map(t => t.id)).toEqual(page2.data.map(t => t.id));
    });

    it("defaults list limit to 50 and separates distinct timestamp pages cleanly", async () => {
      const userId = await ctx.createUser("default-limit");
      for (let i = 0; i < 51; i++) {
        await ctx.repository.create({ name: `Item ${i}`, userId });
      }

      const defaultPage = await ctx.repository.list({ userId });
      expect(defaultPage.data).toHaveLength(50);
      expect(defaultPage.meta.hasMore).toBe(true);
      expect(defaultPage.meta.nextCursor).toBeTruthy();

      const secondPage = await ctx.repository.list({
        userId,
        cursor: defaultPage.meta.nextCursor ?? undefined,
      });
      expect(secondPage.data).toHaveLength(1);
      expect(secondPage.meta).toEqual({ hasMore: false, nextCursor: null });
    });

    it("rejects malformed or wrong-type cursors with BadRequestError", async () => {
      const userId = await ctx.createUser("cursor-err");

      await expect(
        ctx.repository.list({ userId, cursor: "not!base64url" }),
      ).rejects.toBeInstanceOf(BadRequestError);

      await expect(
        ctx.repository.list({
          userId,
          cursor: encodeCursor({ v: "not-a-timestamp", id: crypto.randomUUID() }),
        }),
      ).rejects.toBeInstanceOf(BadRequestError);
    });

    it("normalizes foreign key constraint errors and cascades on user deletion", async () => {
      await expect(
        ctx.repository.create({ name: "Orphan task", userId: crypto.randomUUID() }),
      ).rejects.toBeInstanceOf(BadRequestError);

      const userId = await ctx.createUser("cascade");
      const task = await ctx.repository.create({ name: "Cascade task", userId });

      await ctx.deleteUser(userId);
      expect(await ctx.repository.findById(task.id)).toBeNull();
      expect((await ctx.repository.list({ userId })).data).toEqual([]);
    });
  });
}
