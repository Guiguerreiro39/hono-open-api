import type { TasksServiceDeps } from "./tasks.service";
import { $ } from "@hono/zod-openapi";

import { requireAuth } from "@/core/auth/middlewares";
import { createRouter } from "@/core/http";
import { createTasksHandlers } from "./tasks.handlers";
import {
  createTaskRoute,
  deleteTaskRoute,
  getTaskRoute,
  listTasksRoute,
  patchTaskRoute,
} from "./tasks.routes";
import { createTasksService } from "./tasks.service";

export type TasksModuleDeps = TasksServiceDeps;

export function createTasksModule(deps: TasksModuleDeps) {
  const authMiddleware = requireAuth(deps.auth);
  const service = createTasksService(deps);
  const handlers = createTasksHandlers(service);

  return $(
    createRouter()
      .use("/tasks", authMiddleware)
      .use("/tasks/*", authMiddleware),
  )
    .openapi(listTasksRoute, handlers.listTasks)
    .openapi(createTaskRoute, handlers.createTask)
    .openapi(getTaskRoute, handlers.getTask)
    .openapi(patchTaskRoute, handlers.patchTask)
    .openapi(deleteTaskRoute, handlers.deleteTask);
}
