import type { TasksHandlersDeps } from "./tasks.handlers";
import type { TasksServiceDeps } from "./tasks.service";
import { $ } from "@hono/zod-openapi";

import { requireAuth } from "@/core/auth/middlewares";
import { createRouter } from "@/core/http";
import { createSseConnectionTracker } from "@/core/realtime/sse";
import { createTasksHandlers } from "./tasks.handlers";
import {
  createTaskRoute,
  deleteTaskRoute,
  getTaskRoute,
  listTasksRoute,
  liveTasksRoute,
  patchTaskRoute,
} from "./tasks.routes";
import { createTasksService } from "./tasks.service";

export type TasksModuleDeps = TasksServiceDeps & TasksHandlersDeps & {
  env?: { MAX_SSE_CONNECTIONS: number };
};

export function createTasksModule(deps: TasksModuleDeps) {
  const authMiddleware = requireAuth(deps.auth);
  const service = createTasksService(deps);
  const sseConnections = deps.sseConnections
    ?? (deps.env ? createSseConnectionTracker(deps.env.MAX_SSE_CONNECTIONS) : undefined);
  const handlers = createTasksHandlers(service, {
    ...deps,
    sseConnections,
  });

  return $(
    createRouter()
      .use("/tasks", authMiddleware)
      .use("/tasks/*", authMiddleware),
  )
    .openapi(listTasksRoute, handlers.listTasks)
    .openapi(liveTasksRoute, handlers.liveTasks)
    .openapi(createTaskRoute, handlers.createTask)
    .openapi(getTaskRoute, handlers.getTask)
    .openapi(patchTaskRoute, handlers.patchTask)
    .openapi(deleteTaskRoute, handlers.deleteTask);
}
