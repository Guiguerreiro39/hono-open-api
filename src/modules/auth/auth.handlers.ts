import type { getMeRoute, patchMeRoute } from "./auth.routes";
import type { MeDto } from "./auth.schema";
import type { AuthUser } from "@/core/ports/auth";
import type { AppRouteHandler, PlatformDeps } from "@/core/types";

export interface AuthModuleDeps {
  auth: PlatformDeps["auth"];
}

function formatMe(user: AuthUser): MeDto {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    image: user.image,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    updatedAt: user.updatedAt.toISOString(),
  };
}

export function createAuthHandlers(deps: AuthModuleDeps) {
  const getMe: AppRouteHandler<typeof getMeRoute> = (c) => {
    return c.json(formatMe(c.get("user")), 200);
  };

  const patchMe: AppRouteHandler<typeof patchMeRoute> = async (c) => {
    const body = c.req.valid("json");
    const updated = await deps.auth.updateProfile(c.req.raw.headers, body);
    return c.json(formatMe(updated), 200);
  };

  return {
    getMe,
    patchMe,
  };
}
