import { serve } from "@hono/node-server";

import { createApp } from "@/app";
import { loadEnv } from "@/env";
import { createContainer } from "@/infra/container";
import { registerModuleJobs, registerModuleSchedules } from "@/worker";

const env = loadEnv();
const container = createContainer(env);

if (env.WORKER_EMBEDDED) {
  registerModuleJobs(container);
  await registerModuleSchedules(container);
  container.logger.info({ concurrency: env.WORKER_CONCURRENCY }, "Embedded worker enabled");
}

const app = createApp(container);

container.logger.info({ port: env.PORT, env: env.NODE_ENV }, "Server starting");

const server = serve({
  fetch: app.fetch,
  port: env.PORT,
}, (info) => {
  container.logger.info({ port: info.port }, "Server listening");
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) {
    container.logger.warn({ signal }, "Second signal received; forcing exit");
    process.exit(1);
  }
  shuttingDown = true;
  container.logger.info({ signal }, "Server shutting down");

  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    if ("closeIdleConnections" in server && typeof server.closeIdleConnections === "function") {
      server.closeIdleConnections();
    }
  });

  await container.close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
