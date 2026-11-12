import type { AppDatabase } from "./client";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { migrate } from "drizzle-orm/libsql/migrator";
import { createLogger } from "@/core/logger";
import { loadEnv } from "@/env";
import { createDb } from "./client";

function resolveDefaultMigrationsFolder(): string {
  const adjacent = fileURLToPath(new URL("./migrations", import.meta.url));
  if (existsSync(adjacent)) {
    return adjacent;
  }
  return path.resolve(process.cwd(), "src/infra/db/migrations");
}

export async function migrateDatabase(
  db: AppDatabase,
  migrationsFolder = resolveDefaultMigrationsFolder(),
): Promise<void> {
  await migrate(db, { migrationsFolder });
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
  const env = loadEnv();
  const logger = createLogger(env);
  const { db, close } = createDb(env);

  try {
    await migrateDatabase(db);
    logger.info("Database migrations applied");
  }
  catch (err) {
    logger.error({ err }, "Database migration failed");
    process.exitCode = 1;
  }
  finally {
    await close();
  }
}
