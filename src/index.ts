import { serve } from "@hono/node-server";

import { createApp } from "@/app";
import { loadEnv } from "@/env";
import { createContainer } from "@/infra/container";

const env = loadEnv();
const container = createContainer(env);
const app = createApp(container);

container.logger.info({ port: env.PORT, env: env.NODE_ENV }, "Server starting");

serve({
  fetch: app.fetch,
  port: env.PORT,
}, (info) => {
  container.logger.info({ port: info.port }, "Server listening");
});
