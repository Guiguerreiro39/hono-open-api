import type { AuthPort, AuthSession, AuthUser } from "./core-types";
import { createClient } from "@libsql/client";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, openAPI } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { admin } from "better-auth/plugins/admin";
import { adminAc, defaultStatements, userAc } from "better-auth/plugins/admin/access";
import { relations, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/libsql";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { RBAC_STATEMENTS, ROLE_STATEMENTS } from "./permissions";

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
  image: text("image"),
  role: text("role").notNull().default("user"),
  banned: integer("banned", { mode: "boolean" }).notNull().default(false),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsecond') * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsecond') * 1000)`),
});

export const session = sqliteTable("session", {
  id: text("id").primaryKey(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsecond') * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsecond') * 1000)`),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  impersonatedBy: text("impersonated_by"),
});

export const account = sqliteTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp_ms" }),
  refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp_ms" }),
  scope: text("scope"),
  password: text("password"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsecond') * 1000)`),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsecond') * 1000)`),
});

export const verification = sqliteTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }),
});

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

const schema = {
  user,
  session,
  account,
  verification,
  userRelations,
  sessionRelations,
  accountRelations,
};

const ac = createAccessControl({
  ...defaultStatements,
  ...RBAC_STATEMENTS,
} as const);

const roles = {
  user: ac.newRole({
    ...userAc.statements,
    ...ROLE_STATEMENTS.user,
  }),
  admin: ac.newRole({
    ...adminAc.statements,
    ...ROLE_STATEMENTS.admin,
  }),
};

export async function createPrototypeAuth() {
  const client = createClient({ url: ":memory:" });
  await client.executeMultiple(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 0,
      image TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      banned INTEGER NOT NULL DEFAULT 0,
      ban_reason TEXT,
      ban_expires INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      impersonated_by TEXT
    );
    CREATE TABLE account (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      access_token TEXT,
      refresh_token TEXT,
      id_token TEXT,
      access_token_expires_at INTEGER,
      refresh_token_expires_at INTEGER,
      scope TEXT,
      password TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE verification (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER,
      updated_at INTEGER
    );
  `);

  const db = drizzle(client, { schema, casing: "snake_case" });

  const auth = betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
    }),
    secret: "0123456789abcdef0123456789abcdef",
    baseURL: "http://localhost:3000",
    emailAndPassword: {
      enabled: true,
    },
    experimental: {
      joins: true,
    },
    plugins: [
      admin({
        ac,
        roles,
      }),
      bearer(),
      openAPI({
        disableDefaultReference: true,
      }),
    ],
  });

  type InferredSession = typeof auth.$Infer.Session;
  const _mapUser = (u: InferredSession["user"]): AuthUser => ({
    id: u.id,
    name: u.name,
    email: u.email,
    emailVerified: u.emailVerified,
    image: u.image ?? null,
    role: u.role ?? null,
    banned: Boolean(u.banned),
    banReason: u.banReason ?? null,
    banExpires: u.banExpires ?? null,
    createdAt: u.createdAt,
    updatedAt: u.updatedAt,
  });

  const _mapSession = (s: InferredSession["session"]): AuthSession => ({
    id: s.id,
    userId: s.userId,
    token: s.token,
    expiresAt: s.expiresAt,
    ipAddress: s.ipAddress ?? null,
    userAgent: s.userAgent ?? null,
    impersonatedBy: s.impersonatedBy ?? null,
  });

  const port: AuthPort = {
    async getSession(headers) {
      const res = await auth.api.getSession({ headers });
      if (!res) return null;
      return {
        user: _mapUser(res.user),
        session: _mapSession(res.session),
      };
    },
    async hasPermission({ userId, role, permissions }) {
      const res = await auth.api.userHasPermission({
        body: {
          userId,
          ...(role ? { role: role as "admin" | "user" } : {}),
          permissions,
        },
      });
      return res.success;
    },
    async updateProfile(headers, input) {
      await auth.api.updateUser({
        headers,
        body: input,
      });
      const sessionRes = await auth.api.getSession({ headers });
      if (!sessionRes) {
        throw new Error("Session vanished after updateUser");
      }
      return _mapUser(sessionRes.user);
    },
    handler(req) {
      return auth.handler(req);
    },
  };

  return {
    auth,
    db,
    port,
    close: () => client.close(),
  };
}
