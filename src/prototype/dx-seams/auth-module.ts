import type { PlatformDeps } from "./core-types";
import { $, createRoute, z } from "@hono/zod-openapi";

import { AUTH_SECURITY, createRequireAuth, createRouter, ErrorResponseSchema } from "./core-types";

const MeSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.email(),
  role: z.string().nullable(),
});

const PatchMeSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  image: z.string().nullable().optional(),
});

const getMeRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["Auth"],
  security: AUTH_SECURITY,
  responses: {
    200: {
      description: "Current user",
      content: { "application/json": { schema: MeSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    403: {
      description: "Forbidden",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

const patchMeRoute = createRoute({
  method: "patch",
  path: "/me",
  tags: ["Auth"],
  security: AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: PatchMeSchema } },
    },
  },
  responses: {
    200: {
      description: "Updated user",
      content: { "application/json": { schema: MeSchema } },
    },
    401: {
      description: "Unauthorized",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
    422: {
      description: "Validation error",
      content: { "application/json": { schema: ErrorResponseSchema } },
    },
  },
});

export function createAuthModule(deps: Pick<PlatformDeps, "auth">) {
  const requireAuth = createRequireAuth(deps.auth);

  return $(
    createRouter().use("/me", requireAuth),
  )
    .openapi(getMeRoute, (c) => {
      const user = c.get("user");
      return c.json({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      }, 200);
    })
    .openapi(patchMeRoute, async (c) => {
      const body = c.req.valid("json");
      const updated = await deps.auth.updateProfile(c.req.raw.headers, body);
      return c.json({
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
      }, 200);
    });
}
