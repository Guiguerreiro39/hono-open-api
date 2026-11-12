import type { PaginatedResponse } from "@/core/pagination";

export interface Task {
  id: string;
  name: string;
  done: boolean;
  userId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TaskScope {
  userId?: string;
}

export interface ListTasksParams {
  userId?: string;
  cursor?: string;
  limit?: number;
}

export interface CreateTaskInput {
  name: string;
  done?: boolean;
  userId: string;
}

export interface UpdateTaskInput {
  name?: string;
  done?: boolean;
}

export interface TaskRepository {
  list: (params: ListTasksParams) => Promise<PaginatedResponse<Task>>;
  findById: (id: string, scope?: TaskScope) => Promise<Task | null>;
  create: (input: CreateTaskInput) => Promise<Task>;
  update: (id: string, input: UpdateTaskInput, scope?: TaskScope) => Promise<Task | null>;
  delete: (id: string, scope?: TaskScope) => Promise<boolean>;
}
