import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { parseEnv } from "@/env";
import { createAuthAdapter } from "@/infra/auth";
import { createDb } from "@/infra/db/client";
import { migrateDatabase } from "@/infra/db/migrate";
import { user as userTable } from "@/infra/db/schema";

describe("better auth adapter", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("enforces hardened cookie attributes in production and HTTPS URLs and validates trustedOrigins", async () => {
    const prodEnv = parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: ":memory:",
      CORS_ORIGINS: "https://app.example.com",
      BETTER_AUTH_URL: "https://api.example.com",
      BETTER_AUTH_SECRET: "a-very-long-and-secure-production-secret-32chars",
      S3_BUCKET: "prod-uploads",
    });
    const { db, close } = createDb(prodEnv);
    cleanups.push(close);
    await migrateDatabase(db);

    const { auth, port } = createAuthAdapter(prodEnv, db);
    const authContext = await auth.$context;
    expect(authContext.trustedOrigins).toEqual(expect.arrayContaining([
      "https://app.example.com",
      "https://api.example.com",
    ]));

    const signUpRes = await port.handler(new Request("https://api.example.com/api/auth/sign-up/email", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "origin": "https://app.example.com",
      },
      body: JSON.stringify({
        email: "hardened@example.com",
        password: "Password123!",
        name: "Hardened User",
      }),
    }));
    expect(signUpRes.status).toBe(200);
    const setCookies = signUpRes.headers.getSetCookie();
    const sessionCookie = setCookies.find(cookie =>
      cookie.startsWith("__Secure-better-auth.session_token=")
      || cookie.startsWith("better-auth.session_token="),
    );
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=Lax");
    expect(sessionCookie).toContain("Secure");
    expect(setCookies.some(cookie => cookie.includes("session_data="))).toBe(false);
  });

  it("supports RBAC hasPermission, profile updates, and admin impersonation with UUID IDs", async () => {
    const testEnv = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: ":memory:",
    });
    const { db, close } = createDb(testEnv);
    cleanups.push(close);
    await migrateDatabase(db);

    const { auth, port } = createAuthAdapter(testEnv, db);

    const regular = await auth.api.signUpEmail({
      body: {
        email: "user@example.com",
        password: "Password123!",
        name: "Regular User",
      },
    });
    const admin = await auth.api.signUpEmail({
      body: {
        email: "admin@example.com",
        password: "Password123!",
        name: "Admin User",
      },
    });
    await db.update(userTable).set({ role: "admin" }).where(eq(userTable.id, admin.user.id));

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(regular.user.id).toMatch(uuidRegex);
    expect(admin.user.id).toMatch(uuidRegex);

    expect(await port.hasPermission({
      userId: regular.user.id,
      role: "user",
      permissions: { task: ["create", "read"] },
    })).toBe(true);
    expect(await port.hasPermission({
      userId: regular.user.id,
      role: "user",
      permissions: { task: ["read:any"] },
    })).toBe(false);
    expect(await port.hasPermission({
      userId: admin.user.id,
      role: "admin",
      permissions: { task: ["read:any", "delete:any"], user: ["ban", "impersonate"] },
    })).toBe(true);

    const updated = await port.updateProfile(
      new Headers({ authorization: `Bearer ${regular.token}` }),
      { name: "Updated Name", image: "https://example.com/avatar.png" },
    );
    expect(updated.name).toBe("Updated Name");
    expect(updated.image).toBe("https://example.com/avatar.png");

    const imp = await auth.api.impersonateUser({
      headers: new Headers({ authorization: `Bearer ${admin.token}` }),
      body: { userId: regular.user.id },
    });
    const impSession = await port.getSession(
      new Headers({ authorization: `Bearer ${imp.session.token}` }),
    );
    expect(impSession?.user.id).toBe(regular.user.id);
    expect(impSession?.session.impersonatedBy).toBe(admin.user.id);

    // openAPI plugin disables its built-in /api/auth/reference when disableDefaultReference: true
    const defaultRefRes = await port.handler(new Request("http://localhost:9999/api/auth/reference"));
    expect(defaultRefRes.status).toBe(404);
  });
});
