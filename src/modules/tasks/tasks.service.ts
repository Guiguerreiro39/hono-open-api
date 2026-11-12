import type { Task, TaskRepository, TaskScope } from "./tasks.repository";
import type { CreateTaskDto, ListTasksQuery, UpdateTaskDto } from "./tasks.schema";
import type { PaginatedResponse } from "@/core/pagination";
import type { AuthUser } from "@/core/ports/auth";
import type { PlatformDeps } from "@/core/types";

import { ForbiddenError, NotFoundError } from "@/core/errors";

export interface TasksServiceDeps {
  auth: PlatformDeps["auth"];
  taskRepository: TaskRepository;
}

export interface TasksService {
  listTasks: (user: AuthUser, query: ListTasksQuery) => Promise<PaginatedResponse<Task>>;
  createTask: (user: AuthUser, input: CreateTaskDto) => Promise<Task>;
  getTaskById: (user: AuthUser, id: string) => Promise<Task>;
  updateTask: (user: AuthUser, id: string, input: UpdateTaskDto) => Promise<Task>;
  deleteTask: (user: AuthUser, id: string) => Promise<void>;
}

type TaskAnyAction = "read:any" | "update:any" | "delete:any";

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

  return {
    async listTasks(user, query) {
      const requestsCrossUserScope = query.scope === "all" || query.userId !== undefined;
      if (requestsCrossUserScope) {
        const canReadAny = await hasAnyPermission(user, "read:any");
        if (!canReadAny) {
          throw new ForbiddenError("Insufficient permissions");
        }
      }

      const targetUserId = query.userId !== undefined
        ? query.userId
        : query.scope === "all"
          ? undefined
          : user.id;

      return deps.taskRepository.list({
        userId: targetUserId,
        cursor: query.cursor,
        limit: query.limit,
      });
    },

    createTask(user, input) {
      return deps.taskRepository.create({
        name: input.name,
        done: input.done,
        userId: user.id,
      });
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
      return updated;
    },

    async deleteTask(user, id) {
      const scope = await resolveScope(user, "delete:any");
      const deleted = await deps.taskRepository.delete(id, scope);
      if (!deleted) {
        throw new NotFoundError("Task not found");
      }
    },
  };
}
