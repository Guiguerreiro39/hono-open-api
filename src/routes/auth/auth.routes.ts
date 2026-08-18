import { createRoute, z } from "@hono/zod-openapi";
import * as HttpStatusCodes from "stoker/http-status-codes";
import { jsonContent, jsonContentRequired } from "stoker/openapi/helpers";

const tags = ["Auth"];

export const signUpEmailSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
});

export const signInEmailSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const authResponseSchema = z.object({
  token: z.string().optional(),
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    emailVerified: z.boolean(),
    image: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
});

export const getSessionResponseSchema = z.object({
  user: z.object({
    id: z.string(),
    email: z.string(),
    name: z.string(),
    emailVerified: z.boolean(),
    image: z.string().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
  session: z.object({
    id: z.string(),
    userId: z.string(),
    expiresAt: z.string(),
    token: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    ipAddress: z.string().nullable().optional(),
    userAgent: z.string().nullable().optional(),
  }),
}).nullable();

export const signUpEmail = createRoute({
  path: "/api/auth/sign-up/email",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      signUpEmailSchema,
      "User registration credentials",
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      authResponseSchema,
      "User successfully registered",
    ),
  },
});

export const signInEmail = createRoute({
  path: "/api/auth/sign-in/email",
  method: "post",
  tags,
  request: {
    body: jsonContentRequired(
      signInEmailSchema,
      "User login credentials",
    ),
  },
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      authResponseSchema,
      "User successfully logged in",
    ),
  },
});

export const signOut = createRoute({
  path: "/api/auth/sign-out",
  method: "post",
  tags,
  security: [{ bearerAuth: [] }],
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      z.object({ success: z.boolean() }),
      "User logged out",
    ),
  },
});

export const getSession = createRoute({
  path: "/api/auth/get-session",
  method: "get",
  tags,
  security: [{ bearerAuth: [] }],
  responses: {
    [HttpStatusCodes.OK]: jsonContent(
      getSessionResponseSchema,
      "Current user session",
    ),
  },
});
