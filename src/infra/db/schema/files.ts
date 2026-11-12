import { relations } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { timestamps, uuidPk } from "../helpers";
import { user } from "./auth";

export const files = sqliteTable("files", {
  id: uuidPk(),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  key: text().notNull().unique(),
  originalName: text().notNull(),
  mimeType: text().notNull(),
  sizeBytes: integer().notNull(),
  checksumSha256: text(),
  status: text({ enum: ["pending", "ready"] }).notNull().default("pending"),
  expiresAt: integer({ mode: "timestamp_ms" }),
  ...timestamps(),
}, table => [
  index("files_user_id_status_created_at_id_idx").on(table.userId, table.status, table.createdAt, table.id),
  index("files_status_created_at_id_idx").on(table.status, table.createdAt, table.id),
  index("files_status_expires_at_idx").on(table.status, table.expiresAt),
]);

export const filesRelations = relations(files, ({ one }) => ({
  user: one(user, {
    fields: [files.userId],
    references: [user.id],
  }),
}));
