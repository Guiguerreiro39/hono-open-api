import type { Task } from "./tasks.repository";
import type {
  createTaskRoute,
  deleteTaskRoute,
  getTaskRoute,
  listTasksRoute,
  patchTaskRoute,
} from "./tasks.routes";
import type { TaskDto } from "./tasks.schema";
import type { TasksService } from "./tasks.service";
import type { AppRouteHandler } from "@/core/types";

function formatTask(task: Task): TaskDto {
  return {
    id: task.id,
    name: task.name,
    done: task.done,
    userId: task.userId,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

export function createTasksHandlers(service: TasksService) {
  const listTasks: AppRouteHandler<typeof listTasksRoute> = async (c) => {
    const user = c.get("user");
    const query = c.req.valid("query");
    const result = await service.listTasks(user, query);

    return c.json({
      data: result.data.map(formatTask),
      meta: result.meta,
    }, 200);
  };

  const createTask: AppRouteHandler<typeof createTaskRoute> = async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const created = await service.createTask(user, body);

    return c.json(formatTask(created), 201);
  };

  const getTask: AppRouteHandler<typeof getTaskRoute> = async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const task = await service.getTaskById(user, id);

    return c.json(formatTask(task), 200);
  };

  const patchTask: AppRouteHandler<typeof patchTaskRoute> = async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const updated = await service.updateTask(user, id, body);

    return c.json(formatTask(updated), 200);
  };

  const deleteTask: AppRouteHandler<typeof deleteTaskRoute> = async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    await service.deleteTask(user, id);

    return c.body(null, 204);
  };

  return {
    listTasks,
    createTask,
    getTask,
    patchTask,
    deleteTask,
  };
}
