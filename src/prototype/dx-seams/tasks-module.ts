import type { AppRouteHandler, PlatformDeps } from "./core-types";
import { $, createRoute, z } from "@hono/zod-openapi";

import { AUTH_SECURITY, createLiveQueryStream, createRequireAuth, createRouter, ErrorResponseSchema } from "./core-types";

const TaskSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  done: z.boolean(),
  userId: z.string(),
  createdAt: z.iso.datetime(),
});

const ListTasksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
  scope: z.enum(["own", "all"]).optional(),
});

const CreateTaskSchema = z.object({
  name: z.string().min(1).max(500),
  done: z.boolean().default(false),
});

const listRoute = createRoute({
  method: "get",
  path: "/tasks",
  tags: ["Tasks"],
  security: AUTH_SECURITY,
  request: { query: ListTasksQuerySchema },
  responses: {
    200: {
      description: "Paginated tasks",
      content: {
        "application/json": {
          schema: z.object({
            data: z.array(TaskSchema),
            meta: z.object({ nextCursor: z.string().nullable(), hasMore: z.boolean() }),
          }),
        },
      },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const liveRoute = createRoute({
  method: "get",
  path: "/tasks/live",
  tags: ["Tasks"],
  security: AUTH_SECURITY,
  request: { query: ListTasksQuerySchema },
  responses: {
    200: {
      description: "Live updating tasks via SSE",
      content: {
        "text/event-stream": {
          schema: { type: "string" },
        },
      },
    },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponseSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorResponseSchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorResponseSchema } } },
    429: { description: "Rate limited", content: { "application/json": { schema: ErrorResponseSchema } } },
    503: { description: "Capacity full", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const createTaskRoute = createRoute({
  method: "post",
  path: "/tasks",
  tags: ["Tasks"],
  security: AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: { "application/json": { schema: CreateTaskSchema } },
    },
  },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: TaskSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponseSchema } } },
    422: { description: "Validation error", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const getOneRoute = createRoute({
  method: "get",
  path: "/tasks/{id}",
  tags: ["Tasks"],
  security: AUTH_SECURITY,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    200: { description: "Task", content: { "application/json": { schema: TaskSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const patchTaskRoute = createRoute({
  method: "patch",
  path: "/tasks/{id}",
  tags: ["Tasks"],
  security: AUTH_SECURITY,
  request: {
    params: z.object({ id: z.uuid() }),
    body: {
      required: true,
      content: { "application/json": { schema: CreateTaskSchema.partial() } },
    },
  },
  responses: {
    200: { description: "Updated", content: { "application/json": { schema: TaskSchema } } },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

const deleteTaskRoute = createRoute({
  method: "delete",
  path: "/tasks/{id}",
  tags: ["Tasks"],
  security: AUTH_SECURITY,
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    204: { description: "Deleted" },
    401: { description: "Unauthorized", content: { "application/json": { schema: ErrorResponseSchema } } },
    404: { description: "Not found", content: { "application/json": { schema: ErrorResponseSchema } } },
  },
});

type LiveRoute = typeof liveRoute;

export function createTasksModule(deps: Pick<PlatformDeps, "auth" | "pubsub" | "shutdownSignal">) {
  const requireAuth = createRequireAuth(deps.auth);
  const store: Array<z.infer<typeof TaskSchema>> = [];

  const liveHandler: AppRouteHandler<LiveRoute> = async (c) => {
    const user = c.get("user");
    const { scope } = c.req.valid("query");
    if (scope === "all") {
      const allowed = await deps.auth.hasPermission({
        userId: user.id,
        role: user.role,
        permissions: { task: ["read:any"] },
      });
      if (!allowed) {
        return c.json({
          error: { code: "FORBIDDEN", message: "Forbidden", requestId: c.get("requestId") ?? "unknown" },
        }, 403);
      }
    }
    return createLiveQueryStream({
      c,
      pubsub: deps.pubsub,
      topic: `tasks:${user.id}`,
      fetcher: async () => store.filter(t => t.userId === user.id),
      shutdownSignal: deps.shutdownSignal,
    });
  };

  return $(
    createRouter()
      .use("/tasks", requireAuth)
      .use("/tasks/*", requireAuth),
  )
    .openapi(listRoute, (c) => {
      const user = c.get("user");
      return c.json({
        data: store.filter(t => t.userId === user.id),
        meta: { nextCursor: null, hasMore: false },
      }, 200);
    })
    .openapi(liveRoute, liveHandler)
    .openapi(createTaskRoute, async (c) => {
      const user = c.get("user");
      const input = c.req.valid("json");
      const item = {
        id: crypto.randomUUID(),
        name: input.name,
        done: input.done,
        userId: user.id,
        createdAt: new Date().toISOString(),
      };
      store.push(item);
      await deps.pubsub.publish(`tasks:${user.id}`, { action: "create", data: item });
      return c.json(item, 201);
    })
    .openapi(getOneRoute, (c) => {
      const user = c.get("user");
      const { id } = c.req.valid("param");
      const found = store.find(t => t.id === id && t.userId === user.id);
      if (!found) {
        return c.json({
          error: { code: "NOT_FOUND", message: "Not found", requestId: c.get("requestId") ?? "unknown" },
        }, 404);
      }
      return c.json(found, 200);
    })
    .openapi(patchTaskRoute, (c) => {
      const user = c.get("user");
      const { id } = c.req.valid("param");
      const patch = c.req.valid("json");
      const found = store.find(t => t.id === id && t.userId === user.id);
      if (!found) {
        return c.json({
          error: { code: "NOT_FOUND", message: "Not found", requestId: c.get("requestId") ?? "unknown" },
        }, 404);
      }
      Object.assign(found, patch);
      return c.json(found, 200);
    })
    .openapi(deleteTaskRoute, (c) => {
      const user = c.get("user");
      const { id } = c.req.valid("param");
      const idx = store.findIndex(t => t.id === id && t.userId === user.id);
      if (idx === -1) {
        return c.json({
          error: { code: "NOT_FOUND", message: "Not found", requestId: c.get("requestId") ?? "unknown" },
        }, 404);
      }
      store.splice(idx, 1);
      return c.body(null, 204);
    });
}
