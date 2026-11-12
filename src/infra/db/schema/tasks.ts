import { relations } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { timestamps, uuidPk } from "../helpers";
import { user } from "./auth";

export const tasks = sqliteTable("tasks", {
  id: uuidPk(),
  name: text().notNull(),
  done: integer({ mode: "boolean" }).notNull().default(false),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  ...timestamps(),
}, table => [
  index("tasks_user_id_created_at_id_idx").on(table.userId, table.createdAt, table.id),
  index("tasks_created_at_id_idx").on(table.createdAt, table.id),
]);

export const tasksRelations = relations(tasks, ({ one }) => ({
  user: one(user, {
    fields: [tasks.userId],
    references: [user.id],
  }),
}));
