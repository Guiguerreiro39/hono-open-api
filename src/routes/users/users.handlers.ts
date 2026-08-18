import type { CreateRoute, GetOneRoute, ListRoute, PatchRoute, RemoveRoute } from "./users.routes";
import type { AppRouteHandler } from "@/lib/types";
import { eq } from "drizzle-orm";
import * as HttpStatusCodes from "stoker/http-status-codes";
import * as HttpStatusPhrases from "stoker/http-status-phrases";
import db from "@/db";
import { user as userTable } from "@/db/schema";
import { ZOD_ERROR_CODES, ZOD_ERROR_MESSAGES } from "@/lib/constants";

export const list: AppRouteHandler<ListRoute> = async (c) => {
  const usersList = await db.query.user.findMany();
  return c.json(usersList, HttpStatusCodes.OK);
};

export const create: AppRouteHandler<CreateRoute> = async (c) => {
  const body = c.req.valid("json");
  const now = new Date();
  const id = crypto.randomUUID();
  try {
    const [inserted] = await db.insert(userTable).values({
      ...body,
      id,
      createdAt: now,
      updatedAt: now,
    }).returning();
    return c.json(inserted, HttpStatusCodes.OK);
  }
  catch (err: any) {
    const isUniqueConstraint
      = err?.message?.includes("UNIQUE constraint failed")
        || err?.cause?.message?.includes("UNIQUE constraint failed")
        || err?.cause?.code === "SQLITE_CONSTRAINT_UNIQUE"
        || err?.cause?.code === "SQLITE_CONSTRAINT"
        || err?.code === "SQLITE_CONSTRAINT";

    if (isUniqueConstraint) {
      return c.json(
        {
          message: "Email already exists",
        },
        HttpStatusCodes.CONFLICT,
      );
    }
    throw err;
  }
};

export const getOne: AppRouteHandler<GetOneRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const foundUser = await db.query.user.findFirst({
    where(fields, operators) {
      return operators.eq(fields.id, id);
    },
  });

  if (!foundUser) {
    return c.json(
      {
        message: HttpStatusPhrases.NOT_FOUND,
      },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.json(foundUser, HttpStatusCodes.OK);
};

export const patch: AppRouteHandler<PatchRoute> = async (c) => {
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

  try {
    const [updatedUser] = await db.update(userTable)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(userTable.id, id))
      .returning();

    if (!updatedUser) {
      return c.json(
        {
          message: HttpStatusPhrases.NOT_FOUND,
        },
        HttpStatusCodes.NOT_FOUND,
      );
    }

    return c.json(updatedUser, HttpStatusCodes.OK);
  }
  catch (err: any) {
    const isUniqueConstraint
      = err?.message?.includes("UNIQUE constraint failed")
        || err?.cause?.message?.includes("UNIQUE constraint failed")
        || err?.cause?.code === "SQLITE_CONSTRAINT_UNIQUE"
        || err?.cause?.code === "SQLITE_CONSTRAINT"
        || err?.code === "SQLITE_CONSTRAINT";

    if (isUniqueConstraint) {
      return c.json(
        {
          message: "Email already exists",
        },
        HttpStatusCodes.CONFLICT,
      );
    }
    throw err;
  }
};

export const remove: AppRouteHandler<RemoveRoute> = async (c) => {
  const { id } = c.req.valid("param");
  const result = await db.delete(userTable)
    .where(eq(userTable.id, id));

  if (result.rowsAffected === 0) {
    return c.json(
      {
        message: HttpStatusPhrases.NOT_FOUND,
      },
      HttpStatusCodes.NOT_FOUND,
    );
  }

  return c.body(null, HttpStatusCodes.NO_CONTENT);
};
