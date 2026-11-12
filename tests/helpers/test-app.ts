import type { PlatformDeps } from "@/core/types";
import type { EnvOverrides } from "@/env";
import { testClient } from "hono/testing";

import { createApp } from "@/app";
import { parseEnv } from "@/env";
import { createContainer } from "@/infra/container";
import { migrateDatabase } from "@/infra/db/migrate";

export async function createTestApp(
  envOverrides?: EnvOverrides,
  depsOverrides?: Partial<PlatformDeps>,
) {
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: ":memory:",
    LOG_LEVEL: "silent",
    ...envOverrides,
  });

  const container = createContainer(env);
  await migrateDatabase(container.db);

  const deps: PlatformDeps = {
    ...container,
    ...depsOverrides,
  };

  const app = createApp(deps);
  const client = testClient(app);

  return {
    app,
    client,
    container,
    env,
    cleanup: async () => {
      await container.close();
    },
  };
}
