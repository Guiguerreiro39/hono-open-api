import { createRoute } from "@hono/zod-openapi";

import { createErrorResponses } from "@/core/errors";
import { AUTH_SECURITY } from "@/core/openapi";
import { MeSchema, PatchMeSchema } from "./auth.schema";

export const getMeRoute = createRoute({
  method: "get",
  path: "/me",
  tags: ["Auth"],
  security: AUTH_SECURITY,
  responses: {
    200: {
      description: "Current authenticated user profile",
      content: {
        "application/json": {
          schema: MeSchema,
        },
      },
    },
    ...createErrorResponses(401, 403),
  },
});

export const patchMeRoute = createRoute({
  method: "patch",
  path: "/me",
  tags: ["Auth"],
  security: AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: PatchMeSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated authenticated user profile",
      content: {
        "application/json": {
          schema: MeSchema,
        },
      },
    },
    ...createErrorResponses(401, 403, 422),
  },
});
