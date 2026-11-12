import type { Client } from "@libsql/client";

import type { PlatformDeps } from "@/core/types";
import type { Env } from "@/env";
import type { AppAuth } from "@/infra/auth";
import type { AppDatabase } from "@/infra/db/client";
import type { TaskRepository } from "@/modules/tasks/tasks.repository";
import { createLogger } from "@/core/logger";
import { createAuthAdapter } from "@/infra/auth";
import { createDb } from "@/infra/db/client";
import { createDrizzleTaskRepository } from "@/infra/db/repositories/drizzle-task.repository";
import { createMetricsAdapter } from "@/infra/observability";

export interface Container extends PlatformDeps {
  db: AppDatabase;
  client: Client;
  betterAuth: AppAuth;
  taskRepository: TaskRepository;
  close: () => Promise<void>;
}

export function createContainer(env: Env): Container {
  const logger = createLogger(env);
  const metrics = createMetricsAdapter(env);
  const { db, client, ping, close: closeDb } = createDb(env);
  const { auth: betterAuth, port: auth } = createAuthAdapter(env, db);
  const taskRepository = createDrizzleTaskRepository(db);
  const shutdownController = new AbortController();

  return {
    env,
    logger,
    metrics,
    auth,
    betterAuth,
    db,
    client,
    taskRepository,
    checkDb: ping,
    isShuttingDown: () => shutdownController.signal.aborted,
    shutdownSignal: shutdownController.signal,
    close: async () => {
      if (!shutdownController.signal.aborted) {
        shutdownController.abort();
      }
      await closeDb();
    },
  };
}
