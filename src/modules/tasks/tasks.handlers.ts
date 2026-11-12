import type {
  createTaskRoute,
  deleteTaskRoute,
  getTaskRoute,
  listTasksRoute,
  liveTasksRoute,
  patchTaskRoute,
} from "./tasks.routes";
import type { TasksService } from "./tasks.service";
import type { SseConnectionTracker } from "@/core/realtime/sse";
import type { AppRouteHandler, PlatformDeps } from "@/core/types";
import { createLiveQueryStream } from "@/core/realtime/sse";
import { formatTaskDto } from "./tasks.service";

export interface TasksHandlersDeps {
  pubsub: PlatformDeps["pubsub"];
  metrics: PlatformDeps["metrics"];
  logger: PlatformDeps["logger"];
  shutdownSignal?: PlatformDeps["shutdownSignal"];
  sseConnections?: SseConnectionTracker;
}

export function createTasksHandlers(service: TasksService, deps: TasksHandlersDeps) {
  const listTasks: AppRouteHandler<typeof listTasksRoute> = async (c) => {
    const user = c.get("user");
    const query = c.req.valid("query");
    const result = await service.listTasks(user, query);

    return c.json({
      data: result.data.map(formatTaskDto),
      meta: result.meta,
    }, 200);
  };

  const liveTasks: AppRouteHandler<typeof liveTasksRoute> = async (c) => {
    const user = c.get("user");
    const query = c.req.valid("query");
    const topic = await service.resolveLiveTopic(user, query);

    return createLiveQueryStream({
      c,
      pubsub: deps.pubsub,
      topic,
      metrics: deps.metrics,
      logger: deps.logger,
      shutdownSignal: deps.shutdownSignal,
      connectionTracker: deps.sseConnections,
      fetcher: async () => {
        const result = await service.listTasks(user, query);
        return {
          data: result.data.map(formatTaskDto),
          meta: result.meta,
        };
      },
    });
  };

  const createTask: AppRouteHandler<typeof createTaskRoute> = async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const created = await service.createTask(user, body);

    return c.json(formatTaskDto(created), 201);
  };

  const getTask: AppRouteHandler<typeof getTaskRoute> = async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const task = await service.getTaskById(user, id);

    return c.json(formatTaskDto(task), 200);
  };

  const patchTask: AppRouteHandler<typeof patchTaskRoute> = async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const body = c.req.valid("json");
    const updated = await service.updateTask(user, id, body);

    return c.json(formatTaskDto(updated), 200);
  };

  const deleteTask: AppRouteHandler<typeof deleteTaskRoute> = async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    await service.deleteTask(user, id);

    return c.body(null, 204);
  };

  return {
    listTasks,
    liveTasks,
    createTask,
    getTask,
    patchTask,
    deleteTask,
  };
}
