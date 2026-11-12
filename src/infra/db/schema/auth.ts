import { relations } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { timestamps, uuidPk } from "../helpers";

export const user = sqliteTable("user", {
  id: uuidPk(),
  name: text().notNull(),
  email: text().notNull().unique(),
  emailVerified: integer({ mode: "boolean" }).notNull().default(false),
  image: text(),
  role: text().notNull().default("user"),
  banned: integer({ mode: "boolean" }).notNull().default(false),
  banReason: text(),
  banExpires: integer({ mode: "timestamp_ms" }),
  ...timestamps(),
});

export const session = sqliteTable("session", {
  id: uuidPk(),
  expiresAt: integer({ mode: "timestamp_ms" }).notNull(),
  token: text().notNull().unique(),
  ...timestamps(),
  ipAddress: text(),
  userAgent: text(),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  impersonatedBy: text(),
}, table => [
  index("session_user_id_idx").on(table.userId),
]);

export const account = sqliteTable("account", {
  id: uuidPk(),
  accountId: text().notNull(),
  providerId: text().notNull(),
  userId: text()
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text(),
  refreshToken: text(),
  idToken: text(),
  accessTokenExpiresAt: integer({ mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer({ mode: "timestamp_ms" }),
  scope: text(),
  password: text(),
  ...timestamps(),
}, table => [
  index("account_user_id_idx").on(table.userId),
]);

export const verification = sqliteTable("verification", {
  id: uuidPk(),
  identifier: text().notNull(),
  value: text().notNull(),
  expiresAt: integer({ mode: "timestamp_ms" }).notNull(),
  ...timestamps(),
}, table => [
  index("verification_identifier_idx").on(table.identifier),
]);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, {
    fields: [session.userId],
    references: [user.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, {
    fields: [account.userId],
    references: [user.id],
  }),
}));
