import type { CreateRoute, GetOneRoute, ListRoute, LiveRoute, PatchRoute, RemoveRoute } from "./tasks.routes";
import type { AppRouteHandler } from "@/lib/types";
import { and, eq } from "drizzle-orm";

import * as HttpStatusCodes from "stoker/http-status-codes";

import * as HttpStatusPhrases from "stoker/http-status-phrases";
import db from "@/db";
import { tasks } from "@/db/schema";

import { ZOD_ERROR_CODES, ZOD_ERROR_MESSAGES } from "@/lib/constants";
import { createLiveQueryStream, pubsub } from "@/lib/realtime";

export const list: AppRouteHandler<ListRoute> = async (c) => {
  const user = c.get("user");
  const userTasks = await db.query.tasks.findMany({
    where(fields, operators) {
      return operators.eq(fields.userId, user.id);
    },
  });
  return c.json(userTasks, HttpStatusCodes.OK);
};

export const live: AppRouteHandler<LiveRoute> = async (c) => {
  const user = c.get("user");
  return createLiveQueryStream({
    c,
    topic: `tasks:${user.id}`,
    fetcher: async () => {
      return db.query.tasks.findMany({
        where(fields, operators) {
          return operators.eq(fields.userId, user.id);
        },
      });
    },
  });
};

export const create: AppRouteHandler<CreateRoute> = async (c) => {
  const user = c.get("user");
  const task = c.req.valid("json");
  const [inserted] = await db.insert(tasks).values({
    ...task,
    userId: user.id,
  }).returning();

  pubsub.publish(`tasks:${user.id}`, {
    action: "create",
    data: inserted,
  });

  return c.json(inserted, HttpStatusCodes.OK);
};

export const getOne: AppRouteHandler<GetOneRoute> = async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const task = await db.query.tasks.findFirst({
    where(fields, operators) {
      return operators.and(
        operators.eq(fields.id, id),
        operators.eq(fields.userId, user.id),
      );
    },
  });

  if (!task) {
    return c.json(
      {
        message: HttpStatusPhrases.NOT_FOUND,
      },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.json(task, HttpStatusCodes.OK);
};

export const patch: AppRouteHandler<PatchRoute> = async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const updates = c.req.valid("json");

  if (Object.keys(updates).length === 0) {
    return c.json(
      {
        success: false,
        error: {
          issues: [
            {
              code: ZOD_ERROR_CODES.INVALID_UPDATES,
              path: [],
              message: ZOD_ERROR_MESSAGES.NO_UPDATES,
            },
          ],
          name: "ZodError",
        },
      },
      HttpStatusCodes.UNPROCESSABLE_ENTITY,
    );
  }

  const [task] = await db.update(tasks)
    .set(updates)
    .where(and(eq(tasks.id, id), eq(tasks.userId, user.id)))
    .returning();

  if (!task) {
    return c.json(
      {
        message: HttpStatusPhrases.NOT_FOUND,
      },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  pubsub.publish(`tasks:${user.id}`, {
    action: "update",
    data: task,
  });

  return c.json(task, HttpStatusCodes.OK);
};

export const remove: AppRouteHandler<RemoveRoute> = async (c) => {
  const user = c.get("user");
  const { id } = c.req.valid("param");
  const result = await db.delete(tasks)
    .where(and(eq(tasks.id, id), eq(tasks.userId, user.id)));

  if (result.rowsAffected === 0) {
    return c.json(
      {
        message: HttpStatusPhrases.NOT_FOUND,
      },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  pubsub.publish(`tasks:${user.id}`, {
    action: "delete",
    data: { id },
  });

  return c.body(null, HttpStatusCodes.NO_CONTENT);
};
