import { createRoute } from "@hono/zod-openapi";

import { createErrorResponses } from "@/core/errors";
import { AUTH_SECURITY } from "@/core/openapi";
import {
  CreateTaskSchema,
  ListTasksQuerySchema,
  TaskListResponseSchema,
  TaskParamsSchema,
  TaskSchema,
  UpdateTaskSchema,
} from "./tasks.schema";

export { ListTasksQuerySchema };

export const listTasksRoute = createRoute({
  method: "get",
  path: "/tasks",
  tags: ["Tasks"],
  security: AUTH_SECURITY,
  request: {
    query: ListTasksQuerySchema,
  },
  responses: {
    200: {
      description: "Paginated tasks",
      content: {
        "application/json": {
          schema: TaskListResponseSchema,
        },
      },
    },
    ...createErrorResponses(400, 401, 403, 422),
  },
});

export const liveTasksRoute = createRoute({
  method: "get",
  path: "/tasks/live",
  tags: ["Tasks"],
  security: AUTH_SECURITY,
  request: {
    query: ListTasksQuerySchema,
  },
  responses: {
    200: {
      description: "Live updating tasks via SSE",
      content: {
        "text/event-stream": {
          schema: { type: "string" },
        },
      },
    },
    ...createErrorResponses(400, 401, 403, 422, 429, 503),
  },
});

export const createTaskRoute = createRoute({
  method: "post",
  path: "/tasks",
  tags: ["Tasks"],
  security: AUTH_SECURITY,
  request: {
    body: {
      required: true,
      content: {
        "application/json": {
          schema: CreateTaskSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: "Created task",
      content: {
        "application/json": {
          schema: TaskSchema,
        },
      },
    },
    ...createErrorResponses(401, 403, 422),
  },
});

export const getTaskRoute = createRoute({
  method: "get",
  path: "/tasks/{id}",
  tags: ["Tasks"],
  security: AUTH_SECURITY,
  request: {
    params: TaskParamsSchema,
  },
  responses: {
    200: {
      description: "Task",
      content: {
        "application/json": {
          schema: TaskSchema,
        },
      },
    },
    ...createErrorResponses(401, 403, 404, 422),
  },
});

export const patchTaskRoute = createRoute({
  method: "patch",
  path: "/tasks/{id}",
  tags: ["Tasks"],
  security: AUTH_SECURITY,
  request: {
    params: TaskParamsSchema,
    body: {
      required: true,
      content: {
        "application/json": {
          schema: UpdateTaskSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: "Updated task",
      content: {
        "application/json": {
          schema: TaskSchema,
        },
      },
    },
    ...createErrorResponses(401, 403, 404, 422),
  },
});

export const deleteTaskRoute = createRoute({
  method: "delete",
  path: "/tasks/{id}",
  tags: ["Tasks"],
  security: AUTH_SECURITY,
  request: {
    params: TaskParamsSchema,
  },
  responses: {
    204: {
      description: "Task deleted",
    },
    ...createErrorResponses(401, 403, 404, 422),
  },
});
