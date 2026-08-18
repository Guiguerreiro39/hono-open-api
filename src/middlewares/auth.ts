import type { MiddlewareHandler } from "hono";
import type { AppBindings } from "@/lib/types";

import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";

import { auth } from "@/lib/auth";

export const requireAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const session = await auth.api.getSession({
    headers: c.req.raw.headers,
  });

  if (!session) {
    return c.json(
      { message: HttpStatusPhrases.UNAUTHORIZED },
      HttpStatusCodes.UNAUTHORIZED,
    );
  }

  c.set("user", session.user);
  c.set("session", session.session);

  return next();
};
