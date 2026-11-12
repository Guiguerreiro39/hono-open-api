import { sql } from "drizzle-orm";
import { integer, text } from "drizzle-orm/sqlite-core";

export function uuidPk() {
  return text()
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());
}

export function timestamps() {
  return {
    createdAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .default(sql`(CAST(unixepoch('subsecond') * 1000 AS INTEGER))`),
    updatedAt: integer({ mode: "timestamp_ms" })
      .notNull()
      .default(sql`(CAST(unixepoch('subsecond') * 1000 AS INTEGER))`)
      .$onUpdate(() => new Date()),
  };
}
