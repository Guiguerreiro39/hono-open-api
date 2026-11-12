import type { AppType } from "@/app";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { hc } from "hono/client";
import { afterEach, describe, expect, it } from "vitest";

import { AUTH_SECURITY } from "@/core/openapi";
import { ListTasksQuerySchema } from "@/modules/tasks/tasks.routes";
import { createSseReader } from "../../../tests/helpers/sse";
import { createTestApp } from "../../../tests/helpers/test-app";

function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
    }
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("tasks feature module (/api/v1/tasks)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("keeps src/modules/tasks free of drizzle-orm, drizzle-zod, and infra imports", () => {
    const tasksDir = path.join(process.cwd(), "src/modules/tasks");
    const files = collectTsFiles(tasksDir);

    expect(files.length).toBeGreaterThan(0);
    for (const filePath of files) {
      const source = readFileSync(filePath, "utf8");
      expect(source).not.toMatch(/\bdrizzle-orm\b/);
      expect(source).not.toMatch(/\bdrizzle-zod\b/);
      expect(source).not.toMatch(/@\/infra\//);
    }
  });

  it("supports authenticated CRUD over /api/v1/tasks with AppType inference, 201 create, 422 empty PATCH, and AUTH_SECURITY", async () => {
    const ctx = await createTestApp();
    cleanups.push(ctx.cleanup);

    const user = await ctx.seedUser();
    const rpcClient = hc<AppType>("http://localhost", {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => ctx.app.request(input, init),
    });

    // POST /api/v1/tasks -> 201 unwrapped task
    const createRes = await ctx.client.api.v1.tasks.$post({
      json: { name: "Ship tasks module" },
    }, { headers: user.headers });

    expect(createRes.status).toBe(201);
    if (createRes.status !== 201) {
      throw new Error(`Expected 201, got ${createRes.status}`);
    }

    const created = await createRes.json();
    expect(created).toMatchObject({
      name: "Ship tasks module",
      done: false,
      userId: user.user.id,
    });
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(Date.parse(created.createdAt)).not.toBeNaN();
    expect(Date.parse(created.updatedAt)).not.toBeNaN();

    // GET /api/v1/tasks -> 200 { data, meta }
    const listRes = await rpcClient.api.v1.tasks.$get({
      query: {},
    }, { headers: user.cookieHeaders });
    expect(listRes.status).toBe(200);
    if (listRes.status === 200) {
      const listed = await listRes.json();
      expect(listed.data).toEqual([created]);
      expect(listed.meta).toEqual({ nextCursor: null, hasMore: false });
    }

    // GET /api/v1/tasks/{id} -> 200 unwrapped task
    const getRes = await ctx.client.api.v1.tasks[":id"].$get({
      param: { id: created.id },
    }, { headers: user.headers });
    expect(getRes.status).toBe(200);
    if (getRes.status === 200) {
      expect(await getRes.json()).toEqual(created);
    }

    // PATCH /api/v1/tasks/{id} with {} -> 422
    const emptyPatch = await ctx.client.api.v1.tasks[":id"].$patch({
      param: { id: created.id },
      json: {},
    }, { headers: user.headers });
    expect(emptyPatch.status).toBe(422);
    expect(await emptyPatch.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });

    // PATCH /api/v1/tasks/{id} partial update preserves other fields
    const patchDone = await rpcClient.api.v1.tasks[":id"].$patch({
      param: { id: created.id },
      json: { done: true },
    }, { headers: user.headers });
    expect(patchDone.status).toBe(200);
    if (patchDone.status === 200) {
      const patched = await patchDone.json();
      expect(patched.name).toBe("Ship tasks module");
      expect(patched.done).toBe(true);
    }

    const patchName = await ctx.client.api.v1.tasks[":id"].$patch({
      param: { id: created.id },
      json: { name: "Shipped tasks module" },
    }, { headers: user.headers });
    expect(patchName.status).toBe(200);
    if (patchName.status === 200) {
      const patched = await patchName.json();
      expect(patched.name).toBe("Shipped tasks module");
      expect(patched.done).toBe(true);
    }

    // DELETE /api/v1/tasks/{id} -> 204, then GET -> 404
    const delRes = await ctx.client.api.v1.tasks[":id"].$delete({
      param: { id: created.id },
    }, { headers: user.headers });
    expect(delRes.status).toBe(204);

    const afterDelete = await ctx.client.api.v1.tasks[":id"].$get({
      param: { id: created.id },
    }, { headers: user.headers });
    expect(afterDelete.status).toBe(404);

    // OpenAPI /doc includes AUTH_SECURITY on every /api/v1/tasks route
    const docRes = await ctx.app.request("/doc");
    expect(docRes.status).toBe(200);
    const doc = await docRes.json() as {
      paths?: Record<string, Record<string, { security?: unknown }>>;
    };
    expect(doc.paths?.["/api/v1/tasks"]?.get?.security).toEqual(AUTH_SECURITY);
    expect(doc.paths?.["/api/v1/tasks"]?.post?.security).toEqual(AUTH_SECURITY);
    expect(doc.paths?.["/api/v1/tasks/{id}"]?.get?.security).toEqual(AUTH_SECURITY);
    expect(doc.paths?.["/api/v1/tasks/{id}"]?.patch?.security).toEqual(AUTH_SECURITY);
    expect(doc.paths?.["/api/v1/tasks/{id}"]?.delete?.security).toEqual(AUTH_SECURITY);
  });

  it("paginates GET /api/v1/tasks with base64url cursors, validates inputs, and re-exports ListTasksQuerySchema", async () => {
    expect(ListTasksQuerySchema.parse({})).toEqual({ limit: 50, scope: "own" });
    expect(ListTasksQuerySchema.parse({ scope: "all", limit: "25", userId: "u1" })).toEqual({
      limit: 25,
      scope: "all",
      userId: "u1",
    });

    const ctx = await createTestApp();
    cleanups.push(ctx.cleanup);
    const user = await ctx.seedUser();

    const createdIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await ctx.client.api.v1.tasks.$post({
        json: { name: `Task ${i}`, done: i % 2 === 0 },
      }, { headers: user.headers });
      expect(res.status).toBe(201);
      if (res.status === 201) {
        createdIds.push((await res.json()).id);
      }
    }

    const collectedIds: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const res = await ctx.client.api.v1.tasks.$get({
        query: { limit: "2", ...(cursor ? { cursor } : {}) },
      }, { headers: user.headers });
      expect(res.status).toBe(200);
      if (res.status !== 200) {
        break;
      }
      const body = await res.json();
      collectedIds.push(...body.data.map(t => t.id));
      if (!body.meta.hasMore) {
        expect(body.meta.nextCursor).toBeNull();
        break;
      }
      expect(body.meta.nextCursor).toBeTruthy();
      cursor = body.meta.nextCursor ?? undefined;
    }

    expect(collectedIds).toHaveLength(5);
    expect(new Set(collectedIds).size).toBe(5);
    expect(collectedIds.slice().sort()).toEqual(createdIds.slice().sort());

    // Invalid cursor -> 400
    const badCursorRes = await ctx.client.api.v1.tasks.$get({
      query: { cursor: "invalid!cursor" },
    }, { headers: user.headers });
    expect(badCursorRes.status).toBe(400);
    expect(await badCursorRes.json()).toMatchObject({
      error: { code: "INVALID_CURSOR" },
    });

    // Limit out of bounds -> 422
    expect((await ctx.client.api.v1.tasks.$get({ query: { limit: "0" } }, { headers: user.headers })).status).toBe(422);
    expect((await ctx.client.api.v1.tasks.$get({ query: { limit: "101" } }, { headers: user.headers })).status).toBe(422);

    // Invalid task create payload -> 422
    expect((await ctx.client.api.v1.tasks.$post({ json: { name: "   " } }, { headers: user.headers })).status).toBe(422);
    expect((await ctx.client.api.v1.tasks.$post({ json: { name: "a".repeat(501) } }, { headers: user.headers })).status).toBe(422);

    // Invalid UUID path parameter -> 422
    expect((await ctx.app.request("/api/v1/tasks/not-a-uuid", { headers: user.headers })).status).toBe(422);
    expect((await ctx.app.request("/api/v1/tasks/not-a-uuid", {
      method: "PATCH",
      headers: { ...user.headers, "content-type": "application/json" },
      body: JSON.stringify({ done: true }),
    })).status).toBe(422);
    expect((await ctx.app.request("/api/v1/tasks/not-a-uuid", {
      method: "DELETE",
      headers: user.headers,
    })).status).toBe(422);
  });

  it("enforces 401 unauthenticated, 403 banned, owner scoping (404 on foreign IDs), and :any admin bypass", async () => {
    const ctx = await createTestApp();
    cleanups.push(ctx.cleanup);

    const sampleId = crypto.randomUUID();

    // Unauthenticated -> 401
    expect((await ctx.client.api.v1.tasks.$get({ query: {} })).status).toBe(401);
    expect((await ctx.client.api.v1.tasks.$post({ json: { name: "Anon" } })).status).toBe(401);
    expect((await ctx.client.api.v1.tasks[":id"].$get({ param: { id: sampleId } })).status).toBe(401);
    expect((await ctx.client.api.v1.tasks[":id"].$patch({ param: { id: sampleId }, json: { done: true } })).status).toBe(401);
    expect((await ctx.client.api.v1.tasks[":id"].$delete({ param: { id: sampleId } })).status).toBe(401);

    // Banned user -> 403
    const banned = await ctx.seedBannedUser();
    expect((await ctx.client.api.v1.tasks.$get({ query: {} }, { headers: banned.headers })).status).toBe(403);
    expect((await ctx.client.api.v1.tasks.$post({ json: { name: "Banned" } }, { headers: banned.headers })).status).toBe(403);

    const alice = await ctx.seedUser({ email: "alice-tasks@example.com" });
    const bob = await ctx.seedUser({ email: "bob-tasks@example.com" });
    const admin = await ctx.seedAdmin({ email: "admin-tasks@example.com" });

    const aliceCreate = await ctx.client.api.v1.tasks.$post({
      json: { name: "Alice task" },
    }, { headers: alice.headers });
    const bobCreate = await ctx.client.api.v1.tasks.$post({
      json: { name: "Bob task" },
    }, { headers: bob.headers });
    const adminCreate = await ctx.client.api.v1.tasks.$post({
      json: { name: "Admin task" },
    }, { headers: admin.headers });

    if (aliceCreate.status !== 201 || bobCreate.status !== 201 || adminCreate.status !== 201) {
      throw new Error("Expected task creations to succeed");
    }

    const aliceTask = await aliceCreate.json();
    const bobTask = await bobCreate.json();
    const adminTask = await adminCreate.json();

    // Default list is owner-scoped even for admin
    const aliceList = await ctx.client.api.v1.tasks.$get({ query: { scope: "own" } }, { headers: alice.headers });
    expect(aliceList.status).toBe(200);
    if (aliceList.status === 200) {
      expect((await aliceList.json()).data.map(t => t.id)).toEqual([aliceTask.id]);
    }

    const adminOwnList = await ctx.client.api.v1.tasks.$get({ query: {} }, { headers: admin.headers });
    expect(adminOwnList.status).toBe(200);
    if (adminOwnList.status === 200) {
      expect((await adminOwnList.json()).data.map(t => t.id)).toEqual([adminTask.id]);
    }

    // Regular user cannot use ?scope=all or ?userId= -> 403
    const forbiddenScopeAll = await ctx.client.api.v1.tasks.$get({
      query: { scope: "all" },
    }, { headers: alice.headers });
    expect(forbiddenScopeAll.status).toBe(403);
    expect(await forbiddenScopeAll.json()).toMatchObject({ error: { code: "FORBIDDEN" } });

    const forbiddenUserFilter = await ctx.client.api.v1.tasks.$get({
      query: { userId: bob.user.id },
    }, { headers: alice.headers });
    expect(forbiddenUserFilter.status).toBe(403);

    const forbiddenOwnUserFilter = await ctx.client.api.v1.tasks.$get({
      query: { userId: alice.user.id },
    }, { headers: alice.headers });
    expect(forbiddenOwnUserFilter.status).toBe(403);

    // Regular user targeting foreign task IDs gets 404 without mutating or deleting
    expect((await ctx.client.api.v1.tasks[":id"].$get({ param: { id: bobTask.id } }, { headers: alice.headers })).status).toBe(404);
    expect((await ctx.client.api.v1.tasks[":id"].$patch({ param: { id: bobTask.id }, json: { done: true } }, { headers: alice.headers })).status).toBe(404);
    expect((await ctx.client.api.v1.tasks[":id"].$delete({ param: { id: bobTask.id } }, { headers: alice.headers })).status).toBe(404);

    // Admin with task:read:any can use ?scope=all and ?userId=
    const adminAll = await ctx.client.api.v1.tasks.$get({
      query: { scope: "all" },
    }, { headers: admin.headers });
    expect(adminAll.status).toBe(200);
    if (adminAll.status === 200) {
      const allIds = (await adminAll.json()).data.map(t => t.id).sort();
      expect(allIds).toEqual([aliceTask.id, bobTask.id, adminTask.id].sort());
    }

    const adminByUser = await ctx.client.api.v1.tasks.$get({
      query: { userId: alice.user.id },
    }, { headers: admin.headers });
    expect(adminByUser.status).toBe(200);
    if (adminByUser.status === 200) {
      expect((await adminByUser.json()).data.map(t => t.id)).toEqual([aliceTask.id]);
    }

    // Admin can read, update, and delete foreign tasks
    const adminReadForeign = await ctx.client.api.v1.tasks[":id"].$get({
      param: { id: aliceTask.id },
    }, { headers: admin.headers });
    expect(adminReadForeign.status).toBe(200);

    const adminPatchForeign = await ctx.client.api.v1.tasks[":id"].$patch({
      param: { id: aliceTask.id },
      json: { done: true },
    }, { headers: admin.headers });
    expect(adminPatchForeign.status).toBe(200);
    if (adminPatchForeign.status === 200) {
      const updated = await adminPatchForeign.json();
      expect(updated.done).toBe(true);
      expect(updated.userId).toBe(alice.user.id);
    }

    const adminDeleteForeign = await ctx.client.api.v1.tasks[":id"].$delete({
      param: { id: bobTask.id },
    }, { headers: admin.headers });
    expect(adminDeleteForeign.status).toBe(204);

    expect((await ctx.client.api.v1.tasks[":id"].$get({
      param: { id: bobTask.id },
    }, { headers: admin.headers })).status).toBe(404);
  });

  it("checks exact task:read:any, task:update:any, and task:delete:any capabilities independently", async () => {
    const readOnlyCtx = await createTestApp();
    cleanups.push(readOnlyCtx.cleanup);

    const owner = await readOnlyCtx.seedUser({ email: "owner-gran@example.com" });
    const createRes = await readOnlyCtx.client.api.v1.tasks.$post({
      json: { name: "Protected task" },
    }, { headers: owner.headers });
    if (createRes.status !== 201) {
      throw new Error("Expected task creation");
    }
    const task = await createRes.json();

    const readAnyOnlyAuth = {
      ...readOnlyCtx.container.auth,
      hasPermission: async ({ permissions }: Parameters<typeof readOnlyCtx.container.auth.hasPermission>[0]) => {
        return Boolean(permissions.task?.every(action => action === "read:any"));
      },
    };
    const scopedCtx = await createTestApp(undefined, {
      auth: readAnyOnlyAuth,
      taskRepository: readOnlyCtx.container.taskRepository,
    });
    cleanups.push(scopedCtx.cleanup);

    const caller = await readOnlyCtx.seedUser({ email: "caller-gran@example.com" });
    // Note: caller session lives in readOnlyCtx DB, so share container.auth via readAnyOnlyAuth
    expect((await scopedCtx.client.api.v1.tasks.$get({ query: { scope: "all" } }, { headers: caller.headers })).status).toBe(200);
    expect((await scopedCtx.client.api.v1.tasks[":id"].$get({ param: { id: task.id } }, { headers: caller.headers })).status).toBe(200);
    expect((await scopedCtx.client.api.v1.tasks[":id"].$patch({ param: { id: task.id }, json: { done: true } }, { headers: caller.headers })).status).toBe(404);
    expect((await scopedCtx.client.api.v1.tasks[":id"].$delete({ param: { id: task.id } }, { headers: caller.headers })).status).toBe(404);
  });

  it("streams GET /api/v1/tasks/live with cookie/Bearer auth (401 on ?token=), RBAC scoping, dual-publishing on mutations, OpenAPI spec, and MAX_SSE_CONNECTIONS 503", async () => {
    const ctx = await createTestApp({ MAX_SSE_CONNECTIONS: 2 });
    cleanups.push(ctx.cleanup);

    const alice = await ctx.seedUser({ email: "alice-live@example.com" });
    const bob = await ctx.seedUser({ email: "bob-live@example.com" });
    const admin = await ctx.seedAdmin({ email: "admin-live@example.com" });

    // Missing auth and ?token= query auth alone both return 401
    expect((await ctx.client.api.v1.tasks.live.$get({ query: {} })).status).toBe(401);
    expect((await ctx.app.request(`/api/v1/tasks/live?token=${encodeURIComponent(alice.token)}`)).status).toBe(401);

    // Non-privileged user cannot subscribe to ?scope=all or ?userId=
    expect((await ctx.client.api.v1.tasks.live.$get({ query: { scope: "all" } }, { headers: alice.headers })).status).toBe(403);
    expect((await ctx.client.api.v1.tasks.live.$get({ query: { userId: bob.user.id } }, { headers: alice.headers })).status).toBe(403);

    // OpenAPI /doc describes GET /api/v1/tasks/live properly
    const docRes = await ctx.app.request("/doc");
    expect(docRes.status).toBe(200);
    const doc = await docRes.json() as {
      paths?: Record<string, Record<string, {
        security?: unknown;
        responses?: Record<string, { content?: Record<string, unknown> }>;
      }>>;
    };
    const liveOp = doc.paths?.["/api/v1/tasks/live"]?.get;
    expect(liveOp?.security).toEqual(AUTH_SECURITY);
    expect(liveOp?.responses?.["200"]?.content?.["text/event-stream"]).toEqual({
      schema: { type: "string" },
    });
    expect(Object.keys(liveOp?.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "401", "403", "422", "429", "503"]),
    );

    // Connect Alice via cookie auth and Admin (?scope=all) via Bearer auth (hits MAX_SSE_CONNECTIONS=2)
    const aliceLiveRes = await ctx.client.api.v1.tasks.live.$get({
      query: { limit: "10" },
    }, { headers: alice.cookieHeaders });
    expect(aliceLiveRes.status).toBe(200);
    expect(aliceLiveRes.headers.get("content-type")).toContain("text/event-stream");

    const adminAllRes = await ctx.client.api.v1.tasks.live.$get({
      query: { scope: "all" },
    }, { headers: admin.headers });
    expect(adminAllRes.status).toBe(200);

    const aliceSse = createSseReader(aliceLiveRes);
    const adminSse = createSseReader(adminAllRes);
    cleanups.push(() => aliceSse.close(), () => adminSse.close());

    const aliceInit = await aliceSse.next();
    const adminInit = await adminSse.next();
    expect(aliceInit?.event).toBe("init");
    expect(JSON.parse(aliceInit!.data)).toMatchObject({ data: [], meta: { hasMore: false } });
    expect(adminInit?.event).toBe("init");
    expect(JSON.parse(adminInit!.data)).toMatchObject({ data: [], meta: { hasMore: false } });

    // Third concurrent SSE connection exceeds MAX_SSE_CONNECTIONS=2 -> 503 JSON before flushing SSE headers
    const overCapRes = await ctx.client.api.v1.tasks.live.$get({
      query: {},
    }, {
      headers: {
        ...bob.headers,
        "X-Request-Id": "req-cap-503",
      },
    });
    expect(overCapRes.status).toBe(503);
    expect(overCapRes.headers.get("content-type")).toContain("application/json");
    expect(await overCapRes.json()).toEqual({
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "Too many active SSE connections",
        requestId: "req-cap-503",
      },
    });

    // POST task by Alice -> dual-publishes tasks:<aliceId> and tasks:all
    const createRes = await ctx.client.api.v1.tasks.$post({
      json: { name: "Live task" },
    }, { headers: alice.headers });
    expect(createRes.status).toBe(201);
    if (createRes.status !== 201) {
      throw new Error("Expected task creation");
    }
    const createdTask = await createRes.json();

    const aliceAfterCreate = await aliceSse.next();
    const adminAfterCreate = await adminSse.next();
    expect(aliceAfterCreate?.event).toBe("update");
    expect(JSON.parse(aliceAfterCreate!.data).data.map((t: { id: string }) => t.id)).toEqual([createdTask.id]);
    expect(adminAfterCreate?.event).toBe("update");
    expect(JSON.parse(adminAfterCreate!.data).data.map((t: { id: string }) => t.id)).toEqual([createdTask.id]);

    // Admin PATCH on Alice's task -> dual-publishes to tasks:<aliceId> (owner) and tasks:all
    const patchRes = await ctx.client.api.v1.tasks[":id"].$patch({
      param: { id: createdTask.id },
      json: { done: true },
    }, { headers: admin.headers });
    expect(patchRes.status).toBe(200);

    const aliceAfterPatch = await aliceSse.next();
    const adminAfterPatch = await adminSse.next();
    expect(JSON.parse(aliceAfterPatch!.data).data[0].done).toBe(true);
    expect(JSON.parse(adminAfterPatch!.data).data[0].done).toBe(true);

    // Admin DELETE on Alice's task -> dual-publishes to tasks:<aliceId> and tasks:all
    const deleteRes = await ctx.client.api.v1.tasks[":id"].$delete({
      param: { id: createdTask.id },
    }, { headers: admin.headers });
    expect(deleteRes.status).toBe(204);

    const aliceAfterDelete = await aliceSse.next();
    const adminAfterDelete = await adminSse.next();
    expect(JSON.parse(aliceAfterDelete!.data).data).toEqual([]);
    expect(JSON.parse(adminAfterDelete!.data).data).toEqual([]);

    // Closing one SSE frees capacity for Bob, and admin can subscribe to ?userId=alice.user.id
    await aliceSse.close();
    await new Promise(resolve => setTimeout(resolve, 20));

    const adminAliceRes = await ctx.client.api.v1.tasks.live.$get({
      query: { userId: alice.user.id },
    }, { headers: admin.headers });
    expect(adminAliceRes.status).toBe(200);
    const adminAliceSse = createSseReader(adminAliceRes);
    cleanups.push(() => adminAliceSse.close());
    await adminAliceSse.next();

    // Verify MetricsPort SSE gauge & request counter (while omitting SSE duration histogram)
    const activeMetrics = await (await ctx.app.request("/metrics")).text();
    expect(activeMetrics).toContain("sse_active_connections 2");
    expect(activeMetrics).toContain("sse_connections_total 3");
    expect(activeMetrics).not.toContain("http_request_duration_seconds_count{method=\"GET\",route=\"/api/v1/tasks/live\"");

    // Bob's mutation must NOT trigger an update on admin's ?userId=<aliceId> stream
    await ctx.client.api.v1.tasks.$post({
      json: { name: "Bob private task" },
    }, { headers: bob.headers });
    await ctx.client.api.v1.tasks.$post({
      json: { name: "Alice second task" },
    }, { headers: alice.headers });

    const filteredUpdate = await adminAliceSse.next();
    expect(filteredUpdate?.event).toBe("update");
    expect(JSON.parse(filteredUpdate!.data).data.map((t: { name: string }) => t.name)).toEqual(["Alice second task"]);

    await adminAliceSse.close();
    await adminSse.close();
    await new Promise(resolve => setTimeout(resolve, 20));

    const closedMetrics = await (await ctx.app.request("/metrics")).text();
    expect(closedMetrics).toContain("sse_active_connections 0");
  });
});
