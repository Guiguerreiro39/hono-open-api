import type { Task, TaskRepository, TaskScope } from "./tasks.repository";
import type { CreateTaskDto, ListTasksQuery, TaskDto, UpdateTaskDto } from "./tasks.schema";
import type { PaginatedResponse } from "@/core/pagination";
import type { AuthUser } from "@/core/ports/auth";
import type { PlatformDeps } from "@/core/types";

import { ForbiddenError, NotFoundError } from "@/core/errors";
import { tasksAuditJob } from "./tasks.jobs";

export interface TasksServiceDeps {
  auth: PlatformDeps["auth"];
  queue: PlatformDeps["queue"];
  pubsub: PlatformDeps["pubsub"];
  taskRepository: TaskRepository;
}

export interface TasksService {
  listTasks: (user: AuthUser, query: ListTasksQuery) => Promise<PaginatedResponse<Task>>;
  resolveLiveTopic: (user: AuthUser, query: ListTasksQuery) => Promise<string>;
  createTask: (user: AuthUser, input: CreateTaskDto) => Promise<Task>;
  getTaskById: (user: AuthUser, id: string) => Promise<Task>;
  updateTask: (user: AuthUser, id: string, input: UpdateTaskDto) => Promise<Task>;
  deleteTask: (user: AuthUser, id: string) => Promise<void>;
}

type TaskAnyAction = "read:any" | "update:any" | "delete:any";

export function formatTaskDto(task: Task): TaskDto {
  return {
    id: task.id,
    name: task.name,
    done: task.done,
    userId: task.userId,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

export function createTasksService(deps: TasksServiceDeps): TasksService {
  async function hasAnyPermission(user: AuthUser, action: TaskAnyAction): Promise<boolean> {
    return deps.auth.hasPermission({
      userId: user.id,
      role: user.role,
      permissions: { task: [action] },
    });
  }

  async function resolveScope(user: AuthUser, action: TaskAnyAction): Promise<TaskScope | undefined> {
    const canBypassOwnership = await hasAnyPermission(user, action);
    return canBypassOwnership ? undefined : { userId: user.id };
  }

  async function resolveTargetUserId(user: AuthUser, query: ListTasksQuery): Promise<string | undefined> {
    const requestsCrossUserScope = query.scope === "all" || query.userId !== undefined;
    if (requestsCrossUserScope) {
      const canReadAny = await hasAnyPermission(user, "read:any");
      if (!canReadAny) {
        throw new ForbiddenError("Insufficient permissions");
      }
    }

    return query.userId !== undefined
      ? query.userId
      : query.scope === "all"
        ? undefined
        : user.id;
  }

  async function publishTaskEvent(action: "create" | "update" | "delete", task: Task): Promise<void> {
    const payload = formatTaskDto(task);
    await Promise.all([
      deps.pubsub.publish(`tasks:${task.userId}`, { action, data: payload }),
      deps.pubsub.publish("tasks:all", { action, data: payload }),
    ]);
  }

  return {
    async listTasks(user, query) {
      const targetUserId = await resolveTargetUserId(user, query);

      return deps.taskRepository.list({
        userId: targetUserId,
        cursor: query.cursor,
        limit: query.limit,
      });
    },

    async resolveLiveTopic(user, query) {
      const targetUserId = await resolveTargetUserId(user, query);
      return targetUserId === undefined ? "tasks:all" : `tasks:${targetUserId}`;
    },

    async createTask(user, input) {
      const created = await deps.taskRepository.create({
        name: input.name,
        done: input.done,
        userId: user.id,
      });
      await deps.queue.enqueue(tasksAuditJob, {
        action: "created",
        taskId: created.id,
        userId: created.userId,
        actorId: user.id,
        taskName: created.name,
        done: created.done,
      });
      await publishTaskEvent("create", created);
      return created;
    },

    async getTaskById(user, id) {
      const scope = await resolveScope(user, "read:any");
      const task = await deps.taskRepository.findById(id, scope);
      if (!task) {
        throw new NotFoundError("Task not found");
      }
      return task;
    },

    async updateTask(user, id, input) {
      const scope = await resolveScope(user, "update:any");
      const updated = await deps.taskRepository.update(id, input, scope);
      if (!updated) {
        throw new NotFoundError("Task not found");
      }
      await deps.queue.enqueue(tasksAuditJob, {
        action: "updated",
        taskId: updated.id,
        userId: updated.userId,
        actorId: user.id,
        taskName: updated.name,
        done: updated.done,
      });
      await publishTaskEvent("update", updated);
      return updated;
    },

    async deleteTask(user, id) {
      const scope = await resolveScope(user, "delete:any");
      const existing = await deps.taskRepository.findById(id, scope);
      if (!existing) {
        throw new NotFoundError("Task not found");
      }
      const deleted = await deps.taskRepository.delete(id, scope);
      if (!deleted) {
        throw new NotFoundError("Task not found");
      }
      await deps.queue.enqueue(tasksAuditJob, {
        action: "deleted",
        taskId: existing.id,
        userId: existing.userId,
        actorId: user.id,
        taskName: existing.name,
        done: existing.done,
      });
      await publishTaskEvent("delete", existing);
    },
  };
}
