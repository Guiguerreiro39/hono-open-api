import type { Client } from "@libsql/client";

import type { PlatformDeps } from "@/core/types";
import type { Env } from "@/env";
import type { AppDatabase } from "@/infra/db/client";
import { createLogger } from "@/core/logger";
import { createDb } from "@/infra/db/client";

export interface Container extends PlatformDeps {
  db: AppDatabase;
  client: Client;
  close: () => Promise<void>;
}

export function createContainer(env: Env): Container {
  const logger = createLogger(env);
  const { db, client, ping, close: closeDb } = createDb(env);
  const shutdownController = new AbortController();

  return {
    env,
    logger,
    db,
    client,
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
