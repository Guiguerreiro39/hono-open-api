import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";

import { BadRequestError, ConflictError, ValidationError } from "@/core/errors";
import { parseEnv } from "@/env";
import { createDb } from "@/infra/db/client";
import { normalizeDbError } from "@/infra/db/errors";
import { timestamps, uuidPk } from "@/infra/db/helpers";
import { migrateDatabase } from "@/infra/db/migrate";

describe("database kernel", () => {
  it("runs clean empty baseline migrations on :memory: and probes via ping", async () => {
    const env = parseEnv({ NODE_ENV: "test", DATABASE_URL: ":memory:" });
    const { db, client, ping, close } = createDb(env);

    await migrateDatabase(db);
    await expect(ping()).resolves.toBeUndefined();

    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'",
    );
    expect(tables.rows).toHaveLength(1);

    await close();
    await expect(ping()).rejects.toThrow();
  });

  it("sets WAL mode and busy_timeout=5000 on file: databases", async () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "hono-starter-db-"));
    const dbPath = path.join(tmpDir, "test.db");
    const env = parseEnv({ NODE_ENV: "test", DATABASE_URL: `file:${dbPath}` });
    const { client, ping, close } = createDb(env);

    try {
      await ping();
      const journal = await client.execute("PRAGMA journal_mode");
      const busyTimeout = await client.execute("PRAGMA busy_timeout");
      const foreignKeys = await client.execute("PRAGMA foreign_keys");

      expect(String(journal.rows[0]?.journal_mode).toLowerCase()).toBe("wal");
      expect(Number(busyTimeout.rows[0]?.timeout)).toBe(5000);
      expect(Number(foreignKeys.rows[0]?.foreign_keys)).toBe(1);
    }
    finally {
      await close();
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("supports uuidPk, snake_case casing, timestamp_ms columns, and $onUpdate", async () => {
    const sampleParents = sqliteTable("sample_parents", {
      id: uuidPk(),
      slug: text().notNull().unique(),
      ...timestamps(),
    });

    const sampleChildren = sqliteTable("sample_children", {
      id: uuidPk(),
      parentId: text()
        .notNull()
        .references(() => sampleParents.id),
      title: text().notNull(),
      ...timestamps(),
    });

    const env = parseEnv({ NODE_ENV: "test", DATABASE_URL: ":memory:" });
    const { db, client, close } = createDb(env);

    try {
      await client.execute(`
        CREATE TABLE sample_parents (
          id TEXT PRIMARY KEY NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          created_at INTEGER DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
          updated_at INTEGER DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL
        )
      `);
      await client.execute(`
        CREATE TABLE sample_children (
          id TEXT PRIMARY KEY NOT NULL,
          parent_id TEXT NOT NULL REFERENCES sample_parents(id),
          title TEXT NOT NULL,
          created_at INTEGER DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL,
          updated_at INTEGER DEFAULT (CAST(unixepoch('subsecond') * 1000 AS INTEGER)) NOT NULL
        )
      `);

      const [inserted] = await db.insert(sampleParents).values({ slug: "alpha" }).returning();
      expect(inserted.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
      expect(inserted.createdAt).toBeInstanceOf(Date);
      expect(inserted.updatedAt).toBeInstanceOf(Date);

      await new Promise(resolve => setTimeout(resolve, 10));
      const [updated] = await db
        .update(sampleParents)
        .set({ slug: "alpha-2" })
        .where(eq(sampleParents.id, inserted.id))
        .returning();

      expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(inserted.updatedAt.getTime());

      // Verify constraint error normalization from real SQLite Drizzle queries
      let uniqueErr: unknown;
      try {
        await db.insert(sampleParents).values({ slug: "alpha-2" });
      }
      catch (err) {
        uniqueErr = err;
      }
      expect(normalizeDbError(uniqueErr)).toBeInstanceOf(ConflictError);

      let fkErr: unknown;
      try {
        await db.insert(sampleChildren).values({ parentId: "non-existent", title: "child" });
      }
      catch (err) {
        fkErr = err;
      }
      expect(normalizeDbError(fkErr)).toBeInstanceOf(BadRequestError);
    }
    finally {
      await close();
    }
  });

  it("normalizes SQLite and PostgreSQL constraint error codes cleanly", () => {
    expect(normalizeDbError({ code: "23505" })).toBeInstanceOf(ConflictError);
    expect(normalizeDbError({ code: "23503" })).toBeInstanceOf(BadRequestError);
    expect(normalizeDbError({ code: "23502" })).toBeInstanceOf(ValidationError);
    expect(normalizeDbError({ code: "23514" })).toBeInstanceOf(ValidationError);
    expect(normalizeDbError({ code: "SQLITE_CONSTRAINT", extendedCode: "SQLITE_CONSTRAINT_NOTNULL" })).toBeInstanceOf(ValidationError);
    expect(normalizeDbError({ code: "SQLITE_CONSTRAINT", extendedCode: "SQLITE_CONSTRAINT_CHECK" })).toBeInstanceOf(ValidationError);

    const generic = new Error("connection lost");
    expect(normalizeDbError(generic)).toBe(generic);
  });
});
