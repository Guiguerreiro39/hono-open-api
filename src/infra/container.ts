import type { Client } from "@libsql/client";

import type { PlatformDeps } from "@/core/types";
import type { Env } from "@/env";
import type { AppAuth } from "@/infra/auth";
import type { AppDatabase } from "@/infra/db/client";
import { createLogger } from "@/core/logger";
import { createAuthAdapter } from "@/infra/auth";
import { createDb } from "@/infra/db/client";
import { createStorageAdapter } from "@/infra/storage";

export interface Container extends PlatformDeps {
  db: AppDatabase;
  client: Client;
  betterAuth: AppAuth;
  close: () => Promise<void>;
}

export function createContainer(env: Env): Container {
  const logger = createLogger(env);
  const { db, client, ping, close: closeDb } = createDb(env);
  const { auth: betterAuth, port: auth } = createAuthAdapter(env, db);
  const { port: storage, close: closeStorage } = createStorageAdapter(env);
  const shutdownController = new AbortController();

  return {
    env,
    logger,
    auth,
    storage,
    betterAuth,
    db,
    client,
    checkDb: ping,
    isShuttingDown: () => shutdownController.signal.aborted,
    shutdownSignal: shutdownController.signal,
    close: async () => {
      if (!shutdownController.signal.aborted) {
        shutdownController.abort();
      }
      await closeStorage();
      await closeDb();
    },
  };
}
