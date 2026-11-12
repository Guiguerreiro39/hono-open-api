import type { FileRecord, FileRepository } from "@/modules/files/files.repository";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BadRequestError, ConflictError } from "@/core/errors";
import { encodeCursor } from "@/core/pagination";

export interface FileRepositoryContractContext {
  repository: FileRepository;
  createUser: (label?: string) => Promise<string>;
  deleteUser: (userId: string) => Promise<void>;
  cleanup: () => Promise<void>;
}

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function registerFileRepositoryContractSuite(
  name: string,
  createContext: () => Promise<FileRepositoryContractContext>,
): void {
  describe(`FileRepository contract (${name})`, () => {
    let ctx: FileRepositoryContractContext;

    beforeEach(async () => {
      ctx = await createContext();
    });

    afterEach(async () => {
      await ctx.cleanup();
    });

    it("supports create, findById, update, and delete CRUD lifecycle", async () => {
      const userId = await ctx.createUser("owner");
      const fileId = crypto.randomUUID();
      const expiresAt = new Date(Date.now() + 900_000);

      const pending = await ctx.repository.create({
        id: fileId,
        userId,
        key: `files/${userId}/${fileId}`,
        originalName: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1024,
        checksumSha256: null,
        status: "pending",
        expiresAt,
      });

      expect(pending.id).toBe(fileId);
      expect(pending.id).toMatch(UUID_V4_PATTERN);
      expect(pending.userId).toBe(userId);
      expect(pending.key).toBe(`files/${userId}/${fileId}`);
      expect(pending.originalName).toBe("report.pdf");
      expect(pending.mimeType).toBe("application/pdf");
      expect(pending.sizeBytes).toBe(1024);
      expect(pending.checksumSha256).toBeNull();
      expect(pending.status).toBe("pending");
      expect(pending.expiresAt?.getTime()).toBe(expiresAt.getTime());
      expect(pending.createdAt).toBeInstanceOf(Date);
      expect(pending.updatedAt).toBeInstanceOf(Date);

      expect(await ctx.repository.findById(fileId)).toEqual(pending);
      expect(await ctx.repository.findById(crypto.randomUUID())).toBeNull();

      await new Promise(resolve => setTimeout(resolve, 5));
      const ready = await ctx.repository.update(fileId, {
        status: "ready",
        expiresAt: null,
        sizeBytes: 2048,
        checksumSha256: "a".repeat(64),
      });

      expect(ready).not.toBeNull();
      expect(ready?.status).toBe("ready");
      expect(ready?.expiresAt).toBeNull();
      expect(ready?.sizeBytes).toBe(2048);
      expect(ready?.checksumSha256).toBe("a".repeat(64));
      expect(ready?.updatedAt.getTime()).toBeGreaterThanOrEqual(pending.updatedAt.getTime());

      expect(await ctx.repository.update(crypto.randomUUID(), { status: "ready" })).toBeNull();

      expect(await ctx.repository.delete(fileId)).toBe(true);
      expect(await ctx.repository.findById(fileId)).toBeNull();
      expect(await ctx.repository.delete(fileId)).toBe(false);
    });

    it("defaults list() to ready files and enforces ownership scoping across methods", async () => {
      const aliceId = await ctx.createUser("alice");
      const bobId = await ctx.createUser("bob");

      const aliceReady = await ctx.repository.create({
        userId: aliceId,
        key: `files/${aliceId}/${crypto.randomUUID()}`,
        originalName: "alice.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        status: "ready",
      });
      const alicePending = await ctx.repository.create({
        userId: aliceId,
        key: `files/${aliceId}/${crypto.randomUUID()}`,
        originalName: "alice-pending.txt",
        mimeType: "text/plain",
        sizeBytes: 20,
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000),
      });
      const bobReady = await ctx.repository.create({
        userId: bobId,
        key: `files/${bobId}/${crypto.randomUUID()}`,
        originalName: "bob.txt",
        mimeType: "text/plain",
        sizeBytes: 30,
        status: "ready",
      });

      expect(await ctx.repository.findById(aliceReady.id, { userId: aliceId })).toEqual(aliceReady);
      expect(await ctx.repository.findById(aliceReady.id, { userId: bobId })).toBeNull();
      expect(await ctx.repository.findById(aliceReady.id)).toEqual(aliceReady);

      expect(await ctx.repository.update(alicePending.id, { status: "ready" }, { userId: bobId })).toBeNull();
      expect((await ctx.repository.findById(alicePending.id))?.status).toBe("pending");

      expect(await ctx.repository.delete(bobReady.id, { userId: aliceId })).toBe(false);
      expect(await ctx.repository.findById(bobReady.id)).not.toBeNull();

      // Default list excludes pending rows and scopes by userId
      const aliceList = await ctx.repository.list({ userId: aliceId });
      expect(aliceList.data.map(f => f.id)).toEqual([aliceReady.id]);

      const allReady = await ctx.repository.list({});
      expect(allReady.data.map(f => f.id).sort()).toEqual([aliceReady.id, bobReady.id].sort());

      const explicitPending = await ctx.repository.list({ userId: aliceId, status: "pending" });
      expect(explicitPending.data.map(f => f.id)).toEqual([alicePending.id]);

      expect(await ctx.repository.delete(bobReady.id)).toBe(true);
      expect(await ctx.repository.findById(bobReady.id)).toBeNull();
    });

    it("paginates deterministically with base64url cursors including same-ms tie-breaking", async () => {
      const userId = await ctx.createUser("paginator");
      const created: FileRecord[] = [];
      for (let i = 0; i < 5; i++) {
        const id = crypto.randomUUID();
        created.push(await ctx.repository.create({
          id,
          userId,
          key: `files/${userId}/${id}`,
          originalName: `file-${i}.txt`,
          mimeType: "text/plain",
          sizeBytes: 100 + i,
          status: "ready",
        }));
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

      const page3 = await ctx.repository.list({
        userId,
        limit: 2,
        cursor: page2.meta.nextCursor ?? undefined,
      });
      expect(page3.data).toHaveLength(1);
      expect(page3.meta).toEqual({ hasMore: false, nextCursor: null });

      const visitedIds = [...page1.data, ...page2.data, ...page3.data].map(f => f.id);
      expect(new Set(visitedIds).size).toBe(5);
      expect(visitedIds.slice().sort()).toEqual(created.map(f => f.id).sort());

      // Same-millisecond tie-breaking with limit=1 visits all 5 without skips or duplicates
      const singleSteps: string[] = [];
      let cursor: string | undefined;
      for (let step = 0; step < 10; step++) {
        const res = await ctx.repository.list({ userId, limit: 1, cursor });
        singleSteps.push(...res.data.map(f => f.id));
        if (!res.meta.hasMore || !res.meta.nextCursor) {
          break;
        }
        cursor = res.meta.nextCursor;
      }
      expect(singleSteps).toEqual(visitedIds);
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

    it("finds and atomically deletes only expired pending records", async () => {
      const userId = await ctx.createUser("pruner");
      const now = new Date();
      const past = new Date(now.getTime() - 60_000);
      const future = new Date(now.getTime() + 60_000);

      const expiredPending = await ctx.repository.create({
        userId,
        key: `files/${userId}/${crypto.randomUUID()}`,
        originalName: "expired.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        status: "pending",
        expiresAt: past,
      });
      const activePending = await ctx.repository.create({
        userId,
        key: `files/${userId}/${crypto.randomUUID()}`,
        originalName: "active.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        status: "pending",
        expiresAt: future,
      });
      const readyWithPastExpiry = await ctx.repository.create({
        userId,
        key: `files/${userId}/${crypto.randomUUID()}`,
        originalName: "ready.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        status: "ready",
        expiresAt: past,
      });

      const found = await ctx.repository.findExpiredPending(now);
      expect(found.map(f => f.id)).toEqual([expiredPending.id]);

      const deleted = await ctx.repository.deleteExpiredPending(now);
      expect(deleted.map(f => f.id)).toEqual([expiredPending.id]);

      expect(await ctx.repository.findById(expiredPending.id)).toBeNull();
      expect(await ctx.repository.findById(activePending.id)).not.toBeNull();
      expect(await ctx.repository.findById(readyWithPastExpiry.id)).not.toBeNull();
    });

    it("normalizes unique key and FK errors and cascades on user deletion", async () => {
      await expect(
        ctx.repository.create({
          userId: crypto.randomUUID(),
          key: `files/missing/${crypto.randomUUID()}`,
          originalName: "orphan.txt",
          mimeType: "text/plain",
          sizeBytes: 10,
          status: "ready",
        }),
      ).rejects.toBeInstanceOf(BadRequestError);

      const userId = await ctx.createUser("constraints");
      const dupKey = `files/${userId}/duplicate-key`;
      const created = await ctx.repository.create({
        userId,
        key: dupKey,
        originalName: "first.txt",
        mimeType: "text/plain",
        sizeBytes: 10,
        status: "ready",
      });

      await expect(
        ctx.repository.create({
          userId,
          key: dupKey,
          originalName: "second.txt",
          mimeType: "text/plain",
          sizeBytes: 10,
          status: "ready",
        }),
      ).rejects.toBeInstanceOf(ConflictError);

      await ctx.deleteUser(userId);
      expect(await ctx.repository.findById(created.id)).toBeNull();
    });
  });
}
