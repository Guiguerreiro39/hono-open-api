import type { AppRole, RbacPermissionMap } from "@/core/auth/permissions";
import type { AuthPort, AuthSession, AuthUser } from "@/core/ports/auth";
import type { Env } from "@/env";
import type { AppDatabase } from "@/infra/db/client";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, openAPI } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { admin } from "better-auth/plugins/admin";
import { adminAc, defaultStatements, userAc } from "better-auth/plugins/admin/access";

import { RBAC_STATEMENTS, ROLE_STATEMENTS } from "@/core/auth/permissions";
import { UnauthorizedError } from "@/core/errors";
import * as schema from "@/infra/db/schema";

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

export function createBetterAuth(
  env: Pick<Env, "APP_NAME" | "BETTER_AUTH_SECRET" | "BETTER_AUTH_URL" | "CORS_ORIGINS" | "NODE_ENV">,
  db: AppDatabase,
) {
  const trustedOrigins = Array.from(
    new Set([
      ...env.CORS_ORIGINS,
      new URL(env.BETTER_AUTH_URL).origin,
    ]),
  );

  const isSecureCookie = env.NODE_ENV === "production"
    || env.BETTER_AUTH_URL.startsWith("https://");

  return betterAuth({
    appName: env.APP_NAME,
    database: drizzleAdapter(db, {
      provider: "sqlite",
      schema,
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins,
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: false,
    },
    session: {
      cookieCache: {
        enabled: false,
      },
    },
    advanced: {
      defaultCookieAttributes: {
        httpOnly: true,
        sameSite: "lax",
        secure: isSecureCookie,
      },
      database: {
        generateId: "uuid",
      },
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
}

export type AppAuth = ReturnType<typeof createBetterAuth>;

type InferredAuthSession = AppAuth["$Infer"]["Session"];

function mapUser(u: InferredAuthSession["user"]): AuthUser {
  return {
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
  };
}

function mapSession(s: InferredAuthSession["session"]): AuthSession {
  return {
    id: s.id,
    userId: s.userId,
    token: s.token,
    expiresAt: s.expiresAt,
    ipAddress: s.ipAddress ?? null,
    userAgent: s.userAgent ?? null,
    impersonatedBy: s.impersonatedBy ?? null,
  };
}

export function createAuthAdapter(
  env: Pick<Env, "APP_NAME" | "BETTER_AUTH_SECRET" | "BETTER_AUTH_URL" | "CORS_ORIGINS" | "NODE_ENV">,
  db: AppDatabase,
): { auth: AppAuth; port: AuthPort } {
  const auth = createBetterAuth(env, db);

  const port: AuthPort = {
    async getSession(headers) {
      const res = await auth.api.getSession({ headers });
      if (!res) {
        return null;
      }
      return {
        user: mapUser(res.user),
        session: mapSession(res.session),
      };
    },

    async hasPermission({ userId, role, permissions }) {
      const normalizedPermissions = Object.fromEntries(
        Object.entries(permissions).filter(([, actions]) => actions !== undefined),
      ) as RbacPermissionMap;

      const res = await auth.api.userHasPermission({
        body: {
          userId,
          ...(role ? { role: role as AppRole } : {}),
          permissions: normalizedPermissions,
        },
      });
      return res.success;
    },

    async updateProfile(headers, input) {
      try {
        await auth.api.updateUser({
          headers,
          body: input,
        });
      }
      catch (err) {
        if (err && typeof err === "object" && "statusCode" in err && err.statusCode === 401) {
          throw new UnauthorizedError("Unauthorized");
        }
        throw err;
      }
      const sessionRes = await auth.api.getSession({ headers });
      if (!sessionRes) {
        throw new UnauthorizedError("Session not found");
      }
      return mapUser(sessionRes.user);
    },

    handler(req) {
      return auth.handler(req);
    },
  };

  return { auth, port };
}
