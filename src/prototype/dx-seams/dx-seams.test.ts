import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { user as userTable } from "./auth-infra";
import { createPrototypeTestApp } from "./test-app";

describe("dx-seams prototype", () => {
  let ctx: Awaited<ReturnType<typeof createPrototypeTestApp>>;
  let userHeaders: { authorization: string };
  let userId: string;
  let adminHeaders: { authorization: string };
  let adminId: string;

  beforeAll(async () => {
    ctx = await createPrototypeTestApp();
    const res = await ctx.auth.api.signUpEmail({
      body: {
        email: "proto@example.com",
        password: "password123",
        name: "Proto User",
      },
    });
    userId = res.user.id;
    userHeaders = { authorization: `Bearer ${res.token}` };

    const adminRes = await ctx.auth.api.signUpEmail({
      body: {
        email: "admin@example.com",
        password: "password123",
        name: "Admin User",
      },
    });
    adminId = adminRes.user.id;
    await ctx.db.update(userTable).set({ role: "admin" }).where(eq(userTable.id, adminId));
    adminHeaders = { authorization: `Bearer ${adminRes.token}` };
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  it("infers system, auth, tasks, and files routes on testClient and hc<AppType>", async () => {
    const healthRes = await ctx.client.health.$get();
    expect(healthRes.status).toBe(200);
    if (healthRes.status === 200) {
      const body = await healthRes.json();
      expect(body.status).toBe("ok");
    }

    const meRes = await ctx.rpcClient.api.v1.me.$get(undefined, { headers: userHeaders });
    expect(meRes.status).toBe(200);
    if (meRes.status === 200) {
      const me = await meRes.json();
      expect(me.email).toBe("proto@example.com");
      expect(me.role).toBe("user");
    }

    const created = await ctx.client.api.v1.tasks.$post({
      json: { name: "Verify AppType", done: false },
    }, { headers: userHeaders });
    expect(created.status).toBe(201);
    if (created.status === 201) {
      const task = await created.json();
      expect(task.name).toBe("Verify AppType");
      const fetched = await ctx.client.api.v1.tasks[":id"].$get({
        param: { id: task.id },
      }, { headers: userHeaders });
      expect(fetched.status).toBe(200);

      const patched = await ctx.client.api.v1.tasks[":id"].$patch({
        param: { id: task.id },
        json: { done: true },
      }, { headers: userHeaders });
      expect(patched.status).toBe(200);

      const del = await ctx.client.api.v1.tasks[":id"].$delete({
        param: { id: task.id },
      }, { headers: userHeaders });
      expect(del.status).toBe(204);
    }
  });

  it("handles SSE RouteHandler typing and live stream init event", async () => {
    const res = await ctx.client.api.v1.tasks.live.$get({
      query: { limit: "10" },
    }, { headers: userHeaders });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    const first = await reader.read();
    const text = new TextDecoder().decode(first.value);
    expect(text).toContain("event: init");
    await reader.cancel();

    const forbiddenSse = await ctx.client.api.v1.tasks.live.$get({
      query: { scope: "all" },
    }, { headers: userHeaders });
    expect(forbiddenSse.status).toBe(403);
  });

  it("validates multipart/form-data File upload, OpenAPI 3.0.0 schema, and presign lifecycle", async () => {
    const doc = ctx.app.getOpenAPIDocument({
      openapi: "3.0.0",
      info: { title: "Prototype", version: "1.0.0" },
    });

    const uploadOp = doc.paths?.["/api/v1/files"]?.post;
    const uploadSchema = (uploadOp?.requestBody as any)?.content?.["multipart/form-data"]?.schema;
    expect(uploadSchema?.properties?.file).toEqual({ type: "string", format: "binary" });
    expect(uploadOp?.security).toEqual([{ bearerAuth: [] }, { cookieAuth: [] }]);

    const sseContent = (doc.paths?.["/api/v1/tasks/live"]?.get?.responses?.["200"] as any)?.content;
    expect(sseContent?.["text/event-stream"]?.schema).toEqual({ type: "string" });

    // Non-File string field in multipart form fails validation
    const badForm = new FormData();
    badForm.set("file", "not-a-file");
    const badRes = await ctx.app.request("/api/v1/files", {
      method: "POST",
      headers: userHeaders,
      body: badForm,
    });
    expect(badRes.status).toBe(422);

    const file = new File(["hello-proto"], "hello.txt", { type: "text/plain" });
    const uploadRes = await ctx.client.api.v1.files.$post({
      form: { file },
    }, { headers: userHeaders });

    expect(uploadRes.status).toBe(201);
    if (uploadRes.status === 201) {
      const uploaded = await uploadRes.json();
      expect(uploaded.originalName).toBe("hello.txt");
      expect(uploaded.sizeBytes).toBe(11);

      const listRes = await ctx.client.api.v1.files.$get({ query: {} }, { headers: userHeaders });
      expect(listRes.status).toBe(200);

      const dl = await ctx.client.api.v1.files[":id"].download.$get({
        param: { id: uploaded.id },
      }, { headers: userHeaders });
      expect(dl.status).toBe(200);
      expect(await dl.text()).toBe("hello-proto");

      const urlRes = await ctx.client.api.v1.files[":id"].url.$get({
        param: { id: uploaded.id },
      }, { headers: userHeaders });
      expect(urlRes.status).toBe(200);

      const delRes = await ctx.client.api.v1.files[":id"].$delete({
        param: { id: uploaded.id },
      }, { headers: userHeaders });
      expect(delRes.status).toBe(204);
    }

    // Presign -> /_storage PUT -> complete
    const presignRes = await ctx.client.api.v1.files.presign.$post({
      json: { originalName: "signed.txt", mimeType: "text/plain", sizeBytes: 4 },
    }, { headers: userHeaders });
    expect(presignRes.status).toBe(201);
    if (presignRes.status === 201) {
      const { file: pending, uploadUrl } = await presignRes.json();
      const putRes = await ctx.app.request(uploadUrl, { method: "PUT", body: "abcd" });
      expect(putRes.status).toBe(200);
      const completeRes = await ctx.client.api.v1.files[":id"].complete.$post({
        param: { id: pending.id },
      }, { headers: userHeaders });
      expect(completeRes.status).toBe(200);
    }
  });

  it("verifies Better Auth admin/RBAC, impersonation, ban guard, openAPI HTTP route, Scalar sources, and CSP", async () => {
    const adminCanReadAny = await ctx.deps.auth.hasPermission({
      userId: adminId,
      role: "admin",
      permissions: { task: ["read:any"] },
    });
    expect(adminCanReadAny).toBe(true);

    const userCanReadAny = await ctx.deps.auth.hasPermission({
      userId,
      role: "user",
      permissions: { task: ["read:any"] },
    });
    expect(userCanReadAny).toBe(false);

    // Impersonation + ban via admin API (deletes sessions -> 401) + direct banned flag (403)
    const imp = await ctx.auth.api.impersonateUser({
      headers: adminHeaders,
      body: { userId },
    });
    const impSession = await ctx.deps.auth.getSession(new Headers({ authorization: `Bearer ${imp.session.token}` }));
    expect(impSession?.session.impersonatedBy).toBe(adminId);

    // Direct banned flag with active session triggers requireAuth 403
    await ctx.db.update(userTable).set({ banned: true }).where(eq(userTable.id, userId));
    const bannedActiveMe = await ctx.client.api.v1.me.$get(undefined, { headers: userHeaders });
    expect(bannedActiveMe.status).toBe(403);
    await ctx.db.update(userTable).set({ banned: false }).where(eq(userTable.id, userId));

    // admin.banUser deletes user sessions, so existing token becomes 401
    await ctx.auth.api.banUser({
      headers: adminHeaders,
      body: { userId, banReason: "test" },
    });
    const revokedMe = await ctx.client.api.v1.me.$get(undefined, { headers: userHeaders });
    expect(revokedMe.status).toBe(401);

    // Better Auth OpenAPI HTTP endpoint
    const authDocRes = await ctx.app.request("/api/auth/open-api/generate-schema");
    expect(authDocRes.status).toBe(200);
    const authDocJson = await authDocRes.json() as { openapi: string; paths: Record<string, unknown> };
    expect(authDocJson.openapi).toBe("3.1.1");

    // Scalar HTML + CSP inspection
    const refRes = await ctx.app.request("/reference");
    expect(refRes.status).toBe(200);
    const csp = refRes.headers.get("content-security-policy") ?? "";
    const html = await refRes.text();
    const externalOrigins = [...new Set([...html.matchAll(/https?:\/\/[^"'\s<>)]+/g)].map(m => new URL(m[0]).origin))];
    expect(csp).toContain("https://cdn.jsdelivr.net");
    expect(html).toContain("/api/auth/open-api/generate-schema");
    expect(html).toContain("/doc");
    expect(externalOrigins).toEqual(["https://cdn.jsdelivr.net"]);
  });
});
