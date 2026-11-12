import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { parseEnv } from "@/env";
import { createAuthAdapter } from "@/infra/auth";
import { createDb } from "@/infra/db/client";
import { migrateDatabase } from "@/infra/db/migrate";
import { user as userTable } from "@/infra/db/schema";
import { DEFAULT_SEED_USERS, hasForceFlag, seedDatabase } from "@/infra/db/seed";

describe("database seeding", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("parses --force CLI flag", () => {
    expect(hasForceFlag([])).toBe(false);
    expect(hasForceFlag(["--verbose"])).toBe(false);
    expect(hasForceFlag(["--force"])).toBe(true);
  });

  it("refuses seeding in production unless force is true", async () => {
    const prodEnv = parseEnv({
      NODE_ENV: "production",
      DATABASE_URL: ":memory:",
      REDIS_URL: "redis://localhost:6379",
      BETTER_AUTH_SECRET: "a-very-long-and-secure-production-secret-32chars",
      BETTER_AUTH_URL: "https://api.example.com",
      S3_BUCKET: "prod-uploads",
    });
    const { db, close } = createDb(prodEnv);
    cleanups.push(close);
    await migrateDatabase(db);
    const { auth } = createAuthAdapter(prodEnv, db);

    await expect(seedDatabase({ env: prodEnv, db, auth })).rejects.toThrow(/--force/);
    const rowsBefore = await db.select().from(userTable);
    expect(rowsBefore).toHaveLength(0);

    const forced = await seedDatabase({ env: prodEnv, db, auth, force: true });
    expect(forced.created).toEqual(DEFAULT_SEED_USERS.map(u => u.email));
    expect(forced.skipped).toEqual([]);
  });

  it("seeds admin and user idempotently with working Better Auth credentials", async () => {
    const env = parseEnv({ NODE_ENV: "test", DATABASE_URL: ":memory:" });
    const { db, close } = createDb(env);
    cleanups.push(close);
    await migrateDatabase(db);
    const { auth } = createAuthAdapter(env, db);

    const firstRun = await seedDatabase({ env, db, auth });
    expect(firstRun.created).toEqual(DEFAULT_SEED_USERS.map(u => u.email));
    expect(firstRun.skipped).toEqual([]);

    const secondRun = await seedDatabase({ env, db, auth });
    expect(secondRun.created).toEqual([]);
    expect(secondRun.skipped).toEqual(DEFAULT_SEED_USERS.map(u => u.email));

    const allUsers = await db.select().from(userTable);
    expect(allUsers).toHaveLength(DEFAULT_SEED_USERS.length);

    const [adminRow] = await db
      .select()
      .from(userTable)
      .where(eq(userTable.email, DEFAULT_SEED_USERS[0].email));
    expect(adminRow.role).toBe("admin");
    expect(adminRow.emailVerified).toBe(true);

    // Verify seeded credentials work for real Better Auth sign-in
    const signIn = await auth.api.signInEmail({
      body: {
        email: DEFAULT_SEED_USERS[0].email,
        password: DEFAULT_SEED_USERS[0].password,
      },
    });
    expect(signIn.user.email).toBe(DEFAULT_SEED_USERS[0].email);
    expect(signIn.token).toBeTruthy();
  });
});
