import type { MiddlewareHandler } from "hono";

import type { AppRole, RbacPermissionMap } from "@/core/auth/permissions";
import type { AuthPort, AuthUser } from "@/core/ports/auth";
import type { AppBindings } from "@/core/types";
import { ForbiddenError, UnauthorizedError } from "@/core/errors";

function getAuthenticatedUser(c: { get: (key: "user") => AuthUser | undefined }): AuthUser {
  const user = c.get("user");
  if (!user) {
    throw new UnauthorizedError();
  }
  if (user.banned) {
    throw new ForbiddenError("Account is banned");
  }
  return user;
}

export function requireAuth(auth: AuthPort): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const existingUser = c.get("user");
    const existingSession = c.get("session");
    if (existingUser && existingSession) {
      if (existingUser.banned) {
        throw new ForbiddenError("Account is banned");
      }
      return next();
    }

    const res = await auth.getSession(c.req.raw.headers);
    if (!res) {
      throw new UnauthorizedError();
    }
    if (res.user.banned) {
      throw new ForbiddenError("Account is banned");
    }
    c.set("user", res.user);
    c.set("session", res.session);
    return next();
  };
}

export function requireRole(
  ...roles: Array<AppRole | readonly AppRole[]>
): MiddlewareHandler<AppBindings> {
  const allowedRoles = new Set<string>(roles.flat());

  return async (c, next) => {
    const user = getAuthenticatedUser(c);
    const userRoles = (user.role ?? "")
      .split(",")
      .map(role => role.trim())
      .filter(Boolean);

    if (!userRoles.some(role => allowedRoles.has(role))) {
      throw new ForbiddenError("Insufficient role");
    }

    return next();
  };
}

export function requirePermission(
  auth: AuthPort,
  permissions: RbacPermissionMap,
): MiddlewareHandler<AppBindings> {
  return async (c, next) => {
    const user = getAuthenticatedUser(c);
    const allowed = await auth.hasPermission({
      userId: user.id,
      role: user.role,
      permissions,
    });

    if (!allowed) {
      throw new ForbiddenError("Insufficient permissions");
    }

    return next();
  };
}
