import type { AppType } from "@/app";
import type { MemoryQueueAdapter } from "@/infra/queue";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { hc } from "hono/client";

import { afterEach, describe, expect, it } from "vitest";
import { AUTH_SECURITY } from "@/core/openapi";
import { session as sessionTable, verification as verificationTable } from "@/infra/db/schema";
import { authPruneExpiredJob } from "@/modules/auth/auth.jobs";
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

function extractCookieHeader(res: Response): string {
  const jar = new Map<string, string>();
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(";");
    if (!pair) {
      continue;
    }
    const eqIdx = pair.indexOf("=");
    if (eqIdx <= 0) {
      continue;
    }
    const name = pair.slice(0, eqIdx).trim();
    const value = pair.slice(eqIdx + 1).trim();
    if (value === "" || raw.toLowerCase().includes("max-age=0")) {
      jar.delete(name);
    }
    else {
      jar.set(name, `${name}=${value}`);
    }
  }
  return [...jar.values()].join("; ");
}

describe("auth module, better auth endpoints, and scalar docs", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("keeps src/core and src/modules free of runtime better-auth imports", () => {
    const rootDir = process.cwd();
    const checkedFiles = [
      ...collectTsFiles(path.join(rootDir, "src/core")),
      ...collectTsFiles(path.join(rootDir, "src/modules")),
    ];

    expect(checkedFiles.length).toBeGreaterThan(0);
    for (const filePath of checkedFiles) {
      const source = readFileSync(filePath, "utf8");
      expect(source).not.toMatch(/\bfrom\s+["']better-auth/);
      expect(source).not.toMatch(/\bimport\s+["']better-auth/);
      expect(source).not.toMatch(/\bimport\s*\(\s*["']better-auth/);
      expect(source).not.toMatch(/\brequire\s*\(\s*["']better-auth/);
    }
  });

  it("serves /api/auth/* sign-up, sign-in, session, bearer, cookie, and admin impersonation/ban flows", async () => {
    const ctx = await createTestApp();
    cleanups.push(ctx.cleanup);

    // Sign-up via raw HTTP without clonedReq
    const signUpRes = await ctx.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "alice@example.com",
        password: "Password123!",
        name: "Alice",
      }),
    });
    expect(signUpRes.status).toBe(200);
    const signUpBody = await signUpRes.json() as {
      token: string;
      user: { id: string; email: string; name: string };
    };
    expect(signUpBody.user.email).toBe("alice@example.com");
    expect(signUpBody.token).toBeTruthy();

    // Sign-in with invalid password -> 401
    const badSignInRes = await ctx.app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "alice@example.com",
        password: "WrongPassword123!",
      }),
    });
    expect(badSignInRes.status).toBe(401);

    // Sign-in via raw HTTP with cookies
    const signInRes = await ctx.app.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "alice@example.com",
        password: "Password123!",
      }),
    });
    expect(signInRes.status).toBe(200);
    const cookieHeader = extractCookieHeader(signInRes);
    expect(cookieHeader).toContain("better-auth.session_token=");

    // Cookie auth on /api/auth/get-session
    const cookieSessionRes = await ctx.app.request("/api/auth/get-session", {
      headers: { cookie: cookieHeader },
    });
    expect(cookieSessionRes.status).toBe(200);
    const cookieSessionJson = await cookieSessionRes.json() as { user: { email: string } };
    expect(cookieSessionJson.user.email).toBe("alice@example.com");

    // Sign-out invalidates cookie session
    const signOutRes = await ctx.app.request("/api/auth/sign-out", {
      method: "POST",
      headers: { cookie: cookieHeader },
    });
    expect(signOutRes.status).toBe(200);
    const signedOutMe = await ctx.client.api.v1.me.$get(undefined, {
      headers: { cookie: cookieHeader },
    });
    expect(signedOutMe.status).toBe(401);

    // Admin endpoints over HTTP: list-users, impersonate-user, ban-user
    const admin = await ctx.seedAdmin({ email: "root-admin@example.com" });

    const forbiddenListRes = await ctx.app.request("/api/auth/admin/list-users", {
      headers: { authorization: `Bearer ${signUpBody.token}` },
    });
    expect(forbiddenListRes.status).toBe(403);

    const adminListRes = await ctx.app.request("/api/auth/admin/list-users", {
      headers: admin.headers,
    });
    expect(adminListRes.status).toBe(200);
    const listData = await adminListRes.json() as { users: Array<{ email: string }> };
    expect(listData.users.some(u => u.email === "alice@example.com")).toBe(true);

    const impersonateRes = await ctx.app.request("/api/auth/admin/impersonate-user", {
      method: "POST",
      headers: {
        ...admin.headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({ userId: signUpBody.user.id }),
    });
    expect(impersonateRes.status).toBe(200);
    const impCookie = extractCookieHeader(impersonateRes);
    const impSession = await ctx.container.auth.getSession(new Headers({ cookie: impCookie }));
    expect(impSession?.user.id).toBe(signUpBody.user.id);
    expect(impSession?.session.impersonatedBy).toBe(admin.user.id);

    // Better Auth banUser revokes sessions, yielding 401 on subsequent /api/v1/me
    const banRes = await ctx.app.request("/api/auth/admin/ban-user", {
      method: "POST",
      headers: {
        ...admin.headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({ userId: signUpBody.user.id, banReason: "Policy violation" }),
    });
    expect(banRes.status).toBe(200);

    const revokedMe = await ctx.client.api.v1.me.$get(undefined, {
      headers: { authorization: `Bearer ${signUpBody.token}` },
    });
    expect(revokedMe.status).toBe(401);
  });

  it("exposes GET and PATCH /api/v1/me with RPC typing, Bearer & cookie auth, 401/403/422 guards, and AUTH_SECURITY", async () => {
    const ctx = await createTestApp();
    cleanups.push(ctx.cleanup);

    const rpcClient = hc<AppType>("http://localhost", {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => ctx.app.request(input, init),
    });

    // Unauthenticated or invalid Bearer -> 401
    const unauthGet = await ctx.client.api.v1.me.$get();
    expect(unauthGet.status).toBe(401);

    const invalidBearerGet = await ctx.client.api.v1.me.$get(undefined, {
      headers: { authorization: "Bearer invalid-token" },
    });
    expect(invalidBearerGet.status).toBe(401);

    const unauthPatch = await ctx.client.api.v1.me.$patch({
      json: { name: "Hacker" },
    });
    expect(unauthPatch.status).toBe(401);

    // Active session with user.banned === true -> 403
    const banned = await ctx.seedBannedUser();
    const bannedGet = await ctx.client.api.v1.me.$get(undefined, {
      headers: banned.headers,
    });
    expect(bannedGet.status).toBe(403);
    expect(await bannedGet.json()).toMatchObject({
      error: { code: "FORBIDDEN" },
    });

    const bannedPatch = await ctx.client.api.v1.me.$patch({
      json: { name: "Still Banned" },
    }, {
      headers: banned.headers,
    });
    expect(bannedPatch.status).toBe(403);

    // Valid user with Bearer and cookie auth
    const seeded = await ctx.seedUser({
      email: "profile@example.com",
      name: "Original Name",
    });

    const bearerMeRes = await ctx.client.api.v1.me.$get(undefined, {
      headers: seeded.headers,
    });
    expect(bearerMeRes.status).toBe(200);
    if (bearerMeRes.status === 200) {
      const me = await bearerMeRes.json();
      expect(me).toMatchObject({
        id: seeded.user.id,
        email: "profile@example.com",
        name: "Original Name",
        image: null,
        role: "user",
      });
    }

    const cookieMeRes = await rpcClient.api.v1.me.$get(undefined, {
      headers: seeded.cookieHeaders,
    });
    expect(cookieMeRes.status).toBe(200);

    // Empty PATCH {} -> 422
    const emptyPatchRes = await ctx.client.api.v1.me.$patch({
      json: {},
    }, {
      headers: seeded.headers,
    });
    expect(emptyPatchRes.status).toBe(422);
    expect(await emptyPatchRes.json()).toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });

    // Update name and image, then clear image with null
    const updatedRes = await rpcClient.api.v1.me.$patch({
      json: {
        name: "Renamed User",
        image: "https://example.com/pic.png",
      },
    }, {
      headers: seeded.cookieHeaders,
    });
    expect(updatedRes.status).toBe(200);
    if (updatedRes.status === 200) {
      const updated = await updatedRes.json();
      expect(updated.name).toBe("Renamed User");
      expect(updated.image).toBe("https://example.com/pic.png");
    }

    const clearedRes = await ctx.client.api.v1.me.$patch({
      json: { image: null },
    }, {
      headers: seeded.headers,
    });
    expect(clearedRes.status).toBe(200);
    if (clearedRes.status === 200) {
      const cleared = await clearedRes.json();
      expect(cleared.name).toBe("Renamed User");
      expect(cleared.image).toBeNull();
    }

    // OpenAPI /doc includes /api/v1/me with AUTH_SECURITY
    const docRes = await ctx.app.request("/doc");
    expect(docRes.status).toBe(200);
    const doc = await docRes.json() as {
      paths?: Record<string, {
        get?: { security?: unknown };
        patch?: { security?: unknown };
      }>;
    };
    expect(doc.paths?.["/api/v1/me"]?.get?.security).toEqual(AUTH_SECURITY);
    expect(doc.paths?.["/api/v1/me"]?.patch?.security).toEqual(AUTH_SECURITY);
  });

  it("serves Better Auth OpenAPI schema and Scalar /reference with multi-source config and scoped CSP", async () => {
    const ctx = await createTestApp({ APP_NAME: "Auth Docs Starter" });
    cleanups.push(ctx.cleanup);

    const authDocRes = await ctx.app.request("/api/auth/open-api/generate-schema");
    expect(authDocRes.status).toBe(200);
    const authDoc = await authDocRes.json() as { openapi: string; paths: Record<string, unknown> };
    expect(authDoc.openapi).toBe("3.1.1");
    expect(Object.keys(authDoc.paths).length).toBeGreaterThan(0);

    const refRes = await ctx.app.request("/reference");
    expect(refRes.status).toBe(200);
    const refCsp = refRes.headers.get("content-security-policy") ?? "";
    expect(refCsp).toContain("https://cdn.jsdelivr.net");
    expect(refCsp).toContain("'unsafe-inline'");

    const html = await refRes.text();
    expect(html).toContain("/doc");
    expect(html).toContain("/api/auth/open-api/generate-schema");
    expect(html).toContain("Auth Docs Starter");

    const externalOrigins = [
      ...new Set(
        [...html.matchAll(/https?:\/\/[^"'\s<>)]+/g)].map(match => new URL(match[0]).origin),
      ),
    ];
    expect(externalOrigins).toEqual(["https://cdn.jsdelivr.net"]);

    // Non-/reference routes retain default secureHeaders without cdn.jsdelivr.net CSP
    const healthRes = await ctx.app.request("/health");
    expect(healthRes.headers.get("content-security-policy")).toBeNull();
  });

  it("keeps src/modules/auth free of drizzle-orm and infra imports and prunes only expired session and verification rows", async () => {
    const authDir = path.join(process.cwd(), "src/modules/auth");
    const files = collectTsFiles(authDir);
    expect(files.length).toBeGreaterThan(0);
    for (const filePath of files) {
      const source = readFileSync(filePath, "utf8");
      expect(source).not.toMatch(/\bdrizzle-orm\b/);
      expect(source).not.toMatch(/\bbullmq\b/);
      expect(source).not.toMatch(/@\/infra\//);
    }

    const ctx = await createTestApp();
    cleanups.push(ctx.cleanup);

    const seeded = await ctx.seedUser({ email: "prune-test@example.com" });

    const nowMs = Date.now();
    const expiredAt = new Date(nowMs - 60_000);
    const futureAt = new Date(nowMs + 3_600_000);

    await ctx.container.db.insert(sessionTable).values([
      {
        id: crypto.randomUUID(),
        token: `expired-tok-${crypto.randomUUID()}`,
        userId: seeded.user.id,
        expiresAt: expiredAt,
      },
      {
        id: crypto.randomUUID(),
        token: `active-tok-${crypto.randomUUID()}`,
        userId: seeded.user.id,
        expiresAt: futureAt,
      },
    ]);

    await ctx.container.db.insert(verificationTable).values([
      {
        id: crypto.randomUUID(),
        identifier: "expired@example.com",
        value: "v-expired",
        expiresAt: expiredAt,
      },
      {
        id: crypto.randomUUID(),
        identifier: "active@example.com",
        value: "v-active",
        expiresAt: futureAt,
      },
    ]);

    await ctx.container.queue.enqueue(authPruneExpiredJob, {});
    await (ctx.container.queue as MemoryQueueAdapter).drain();

    const remainingSessions = await ctx.container.db.select().from(sessionTable);
    const remainingVerifications = await ctx.container.db.select().from(verificationTable);

    // Seeded user's active session + explicitly inserted active session remain; expired session is gone
    expect(remainingSessions.every(s => s.expiresAt.getTime() > nowMs)).toBe(true);
    expect(remainingSessions).toHaveLength(2);

    expect(remainingVerifications).toHaveLength(1);
    expect(remainingVerifications[0].identifier).toBe("active@example.com");
  });
});
