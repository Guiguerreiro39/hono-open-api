import type { AppRole } from "@/core/auth/permissions";
import type { Env } from "@/env";
import type { AppAuth } from "@/infra/auth";
import type { AppDatabase } from "@/infra/db/client";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { eq } from "drizzle-orm";
import { createLogger } from "@/core/logger";
import { loadEnv } from "@/env";
import { createAuthAdapter } from "@/infra/auth";
import { createDb } from "@/infra/db/client";
import { user as userTable } from "@/infra/db/schema";

export interface SeedUserInput {
  email: string;
  password: string;
  name: string;
  role: AppRole;
}

export const DEFAULT_SEED_USERS: readonly SeedUserInput[] = [
  {
    email: "admin@example.com",
    password: "AdminPassword123!",
    name: "Seed Admin",
    role: "admin",
  },
  {
    email: "user@example.com",
    password: "UserPassword123!",
    name: "Seed User",
    role: "user",
  },
];

export interface SeedDatabaseOptions {
  env: Pick<Env, "NODE_ENV">;
  db: AppDatabase;
  auth: AppAuth;
  force?: boolean;
  users?: readonly SeedUserInput[];
}

export interface SeedResult {
  created: string[];
  skipped: string[];
}

export function hasForceFlag(argv: readonly string[]): boolean {
  return argv.includes("--force");
}

export async function seedDatabase(options: SeedDatabaseOptions): Promise<SeedResult> {
  const { env, db, auth, force = false, users = DEFAULT_SEED_USERS } = options;

  if (env.NODE_ENV === "production" && !force) {
    throw new Error("Refusing to seed database in production without --force");
  }

  const created: string[] = [];
  const skipped: string[] = [];

  for (const seedUser of users) {
    const email = seedUser.email.toLowerCase();
    const existing = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, email))
      .limit(1);

    if (existing.length > 0) {
      skipped.push(email);
      continue;
    }

    await auth.api.createUser({
      body: {
        email,
        password: seedUser.password,
        name: seedUser.name,
        role: seedUser.role,
        data: {
          emailVerified: true,
        },
      },
    });
    created.push(email);
  }

  return { created, skipped };
}

function isDirectCliInvocation(): boolean {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return false;
  }
  try {
    return pathToFileURL(realpathSync(entrypoint)).href === import.meta.url;
  }
  catch {
    return false;
  }
}

if (isDirectCliInvocation()) {
  const force = hasForceFlag(process.argv.slice(2));
  const env = loadEnv();
  const logger = createLogger(env);

  if (env.NODE_ENV === "production" && !force) {
    logger.error("Refusing to seed database in production without --force");
    process.exitCode = 1;
  }
  else {
    const { db, close } = createDb(env);
    const { auth } = createAuthAdapter(env, db);

    try {
      const result = await seedDatabase({ env, db, auth, force });
      logger.info(result, "Database seed completed");
    }
    catch (err) {
      logger.error({ err }, "Database seed failed");
      process.exitCode = 1;
    }
    finally {
      await close();
    }
  }
}
