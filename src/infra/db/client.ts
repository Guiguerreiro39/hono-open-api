import type { Client } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

import type { Env } from "@/env";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";

import * as schema from "./schema";

export type AppSchema = typeof schema;
export type AppDatabase = LibSQLDatabase<AppSchema> & { $client: Client };

export interface DatabaseConnection {
  db: AppDatabase;
  client: Client;
  ping: () => Promise<void>;
  close: () => Promise<void>;
}

const PRAGMA_GATED_METHODS = new Set<keyof Client>([
  "execute",
  "batch",
  "migrate",
  "transaction",
  "executeMultiple",
]);

function isInMemoryUrl(url: string): boolean {
  return url === ":memory:" || url.startsWith("file::memory:") || url.includes("mode=memory");
}

function isLocalFileUrl(url: string): boolean {
  return url.startsWith("file:") && !isInMemoryUrl(url);
}

function isLocalSqliteUrl(url: string): boolean {
  return isInMemoryUrl(url) || url.startsWith("file:");
}

function wrapClientWithPragmas(rawClient: Client, databaseUrl: string): Client {
  if (!isLocalSqliteUrl(databaseUrl)) {
    return rawClient;
  }

  let pragmaPromise: Promise<void> | null = null;
  const applyFilePragmas = isLocalFileUrl(databaseUrl);

  const ensurePragmas = () => {
    if (!pragmaPromise) {
      pragmaPromise = (async () => {
        if (applyFilePragmas) {
          await rawClient.execute("PRAGMA journal_mode = WAL");
          await rawClient.execute("PRAGMA busy_timeout = 5000");
        }
        await rawClient.execute("PRAGMA foreign_keys = ON");
      })().catch((err) => {
        pragmaPromise = null;
        throw err;
      });
    }
    return pragmaPromise;
  };

  return new Proxy(rawClient, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== "function") {
        return value;
      }
      if (PRAGMA_GATED_METHODS.has(prop as keyof Client)) {
        return async (...args: unknown[]) => {
          await ensurePragmas();
          return (value as (...fnArgs: unknown[]) => unknown).apply(target, args);
        };
      }
      return value.bind(target);
    },
  });
}

export function createDb(
  env: Pick<Env, "DATABASE_URL" | "DATABASE_AUTH_TOKEN">,
): DatabaseConnection {
  const rawClient = createClient({
    url: env.DATABASE_URL,
    authToken: env.DATABASE_AUTH_TOKEN,
  });
  const client = wrapClientWithPragmas(rawClient, env.DATABASE_URL);
  const db = drizzle(client, {
    schema,
    casing: "snake_case",
  }) as AppDatabase;

  return {
    db,
    client,
    ping: async () => {
      await client.execute("SELECT 1");
    },
    close: async () => {
      if (!rawClient.closed) {
        rawClient.close();
      }
    },
  };
}
