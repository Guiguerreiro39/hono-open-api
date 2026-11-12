import { defineConfig } from "drizzle-kit";

import { loadEnv } from "@/env";

const env = loadEnv();

export default defineConfig({
  schema: "./src/infra/db/schema/index.ts",
  out: "./src/infra/db/migrations",
  dialect: "turso",
  casing: "snake_case",
  dbCredentials: {
    url: env.DATABASE_URL,
    authToken: env.DATABASE_AUTH_TOKEN,
  },
});
