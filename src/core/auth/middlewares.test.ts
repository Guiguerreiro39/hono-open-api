import type { AuthPort, AuthSessionResult, AuthUser } from "@/core/ports/auth";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import { requireAuth, requirePermission, requireRole } from "@/core/auth/middlewares";
import { RBAC_STATEMENTS, ROLE_STATEMENTS } from "@/core/auth/permissions";
import { createErrorHandler } from "@/core/errors";
import { createRouter } from "@/core/http";

function createTestUser(overrides?: Partial<AuthUser>): AuthUser {
  const now = new Date("2026-01-01T00:00:00.000Z");
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "Test User",
    email: "user@example.com",
    emailVerified: true,
    image: null,
    role: "user",
    banned: false,
    banReason: null,
    banExpires: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createFakeAuthPort(sessionResult: AuthSessionResult | null): AuthPort {
  return {
    getSession: async () => sessionResult,
    hasPermission: async ({ role, permissions }) => {
      const roles = (role ?? "user").split(",").map(r => r.trim()).filter(Boolean);
      return roles.some((r) => {
        if (r !== "user" && r !== "admin") {
          return false;
        }
        const statements = ROLE_STATEMENTS[r];
        return Object.entries(permissions).every(([resource, actions]) => {
          if (!actions || actions.length === 0) {
            return true;
          }
          const allowed = statements[resource as keyof typeof statements] as readonly string[];
          return actions.every(action => allowed.includes(action));
        });
      });
    },
    updateProfile: async () => {
      throw new Error("Not implemented");
    },
    pruneExpired: async () => ({ sessionsDeleted: 0, verificationsDeleted: 0 }),
    handler: async () => new Response("ok"),
  };
}

function buildTestRouter(auth: AuthPort) {
  const app = createRouter();
  app.onError(createErrorHandler());
  app.use("/protected/*", requireAuth(auth));
  app.get("/protected/me", (c) => {
    return c.json({
      userId: c.get("user").id,
      impersonatedBy: c.get("session").impersonatedBy,
    });
  });
  app.get("/protected/admin-role", requireRole("admin"), c => c.json({ ok: true }));
  app.get("/protected/task-any", requirePermission(auth, { task: ["read:any"] }), c => c.json({ ok: true }));
  app.get("/unauthenticated-role", requireRole("admin"), c => c.json({ ok: true }));
  app.get("/unauthenticated-perm", requirePermission(auth, { task: ["read"] }), c => c.json({ ok: true }));
  return new Hono().route("/", app);
}

describe("core auth middlewares and RBAC", () => {
  it("defines pure RBAC statements and role permissions including :any bypass actions", () => {
    expect(RBAC_STATEMENTS.task).toContain("read:any");
    expect(RBAC_STATEMENTS.task).toContain("update:any");
    expect(RBAC_STATEMENTS.task).toContain("delete:any");
    expect(RBAC_STATEMENTS.user).toContain("list");
    expect(RBAC_STATEMENTS.user).toContain("ban");
    expect(ROLE_STATEMENTS.user.task).not.toContain("read:any");
    expect(ROLE_STATEMENTS.admin.task).toContain("read:any");
  });

  it("returns 401 when session is missing and 403 when user is banned", async () => {
    const anonApp = buildTestRouter(createFakeAuthPort(null));
    const anonRes = await anonApp.request("/protected/me");
    expect(anonRes.status).toBe(401);
    expect(await anonRes.json()).toMatchObject({
      error: { code: "UNAUTHORIZED" },
    });

    const bannedUser = createTestUser({ banned: true, banReason: "Spam" });
    const bannedApp = buildTestRouter(createFakeAuthPort({
      user: bannedUser,
      session: {
        id: "sess-1",
        userId: bannedUser.id,
        token: "tok-1",
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        ipAddress: null,
        userAgent: null,
        impersonatedBy: null,
      },
    }));
    const bannedRes = await bannedApp.request("/protected/me");
    expect(bannedRes.status).toBe(403);
    expect(await bannedRes.json()).toMatchObject({
      error: { code: "FORBIDDEN" },
    });
  });

  it("enforces requireRole and requirePermission across user, multi-role, and admin sessions", async () => {
    const normalUser = createTestUser({ role: "user" });
    const userApp = buildTestRouter(createFakeAuthPort({
      user: normalUser,
      session: {
        id: "sess-2",
        userId: normalUser.id,
        token: "tok-2",
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        ipAddress: null,
        userAgent: null,
        impersonatedBy: "admin-1",
      },
    }));

    const meRes = await userApp.request("/protected/me");
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toEqual({
      userId: normalUser.id,
      impersonatedBy: "admin-1",
    });

    expect((await userApp.request("/protected/admin-role")).status).toBe(403);
    expect((await userApp.request("/protected/task-any")).status).toBe(403);
    expect((await userApp.request("/unauthenticated-role")).status).toBe(401);
    expect((await userApp.request("/unauthenticated-perm")).status).toBe(401);

    const adminUser = createTestUser({ role: "user,admin" });
    const adminApp = buildTestRouter(createFakeAuthPort({
      user: adminUser,
      session: {
        id: "sess-3",
        userId: adminUser.id,
        token: "tok-3",
        expiresAt: new Date("2027-01-01T00:00:00.000Z"),
        ipAddress: null,
        userAgent: null,
        impersonatedBy: null,
      },
    }));
    expect((await adminApp.request("/protected/admin-role")).status).toBe(200);
    expect((await adminApp.request("/protected/task-any")).status).toBe(200);
  });
});
