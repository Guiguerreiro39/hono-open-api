import type { AuthUser } from "@/core/ports/auth";
import type { EnvOverrides } from "@/env";
import { eq } from "drizzle-orm";
import { testClient } from "hono/testing";

import { createApp } from "@/app";
import { parseEnv } from "@/env";
import { createContainer } from "@/infra/container";
import { migrateDatabase } from "@/infra/db/migrate";
import { user as userTable } from "@/infra/db/schema";

export interface SeedUserOptions {
  email?: string;
  password?: string;
  name?: string;
  image?: string | null;
}

export interface SeedBannedUserOptions extends SeedUserOptions {
  banReason?: string;
  banExpires?: Date | null;
}

export interface SeededUserResult {
  user: AuthUser;
  token: string;
  cookie: string;
  headers: Record<string, string>;
  cookieHeaders: Record<string, string>;
}

function extractCookieHeader(headers: Headers): string {
  return headers
    .getSetCookie()
    .map(cookie => cookie.split(";")[0])
    .filter(Boolean)
    .join("; ");
}

export async function createTestApp(
  envOverrides?: EnvOverrides,
  depsOverrides?: Partial<Parameters<typeof createApp>[0]>,
) {
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: ":memory:",
    LOG_LEVEL: "silent",
    ...envOverrides,
  });

  const container = createContainer(env);
  await migrateDatabase(container.db);

  const deps: Parameters<typeof createApp>[0] = {
    ...container,
    ...depsOverrides,
  };

  const app = createApp(deps);
  const client = testClient(app);

  async function seedAccount(
    defaultPrefix: string,
    defaultName: string,
    options?: SeedUserOptions,
    dbUpdates?: Partial<typeof userTable.$inferInsert>,
  ): Promise<SeededUserResult> {
    const email = options?.email ?? `${defaultPrefix}-${crypto.randomUUID()}@example.com`;
    const password = options?.password ?? "Password123!";
    const name = options?.name ?? defaultName;

    const signUp = await container.betterAuth.api.signUpEmail({
      body: {
        email,
        password,
        name,
        ...(typeof options?.image === "string" ? { image: options.image } : {}),
      },
      returnHeaders: true,
    });

    const userId = signUp.response.user.id;
    if (dbUpdates || options?.image === null) {
      await container.db
        .update(userTable)
        .set({
          ...dbUpdates,
          ...(options?.image === null ? { image: null } : {}),
        })
        .where(eq(userTable.id, userId));
    }

    const token = signUp.response.token ?? "";
    const cookie = extractCookieHeader(signUp.headers);
    const headers = { authorization: `Bearer ${token}` };
    const cookieHeaders = { cookie };
    const session = await container.auth.getSession(new Headers(headers));

    if (!session) {
      throw new Error(`Failed to resolve seeded session for ${email}`);
    }

    return {
      user: session.user,
      token,
      cookie,
      headers,
      cookieHeaders,
    };
  }

  return {
    app,
    client,
    container,
    env,
    seedUser: (options?: SeedUserOptions) => seedAccount("user", "Test User", options),
    seedAdmin: (options?: SeedUserOptions) => seedAccount("admin", "Admin User", options, { role: "admin" }),
    seedBannedUser: (options?: SeedBannedUserOptions) =>
      seedAccount("banned", "Banned User", options, {
        banned: true,
        banReason: options?.banReason ?? "Banned in test",
        banExpires: options?.banExpires ?? null,
      }),
    cleanup: async () => {
      await container.close();
    },
  };
}
