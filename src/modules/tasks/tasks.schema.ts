import { z } from "@hono/zod-openapi";

import { createPaginatedResponseSchema, PaginationQuerySchema } from "@/core/pagination";

export const TaskSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  done: z.boolean(),
  userId: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const TaskParamsSchema = z.object({
  id: z.uuid(),
});

export const ListTasksQuerySchema = PaginationQuerySchema.extend({
  scope: z.enum(["own", "all"]).default("own"),
  userId: z.string().trim().min(1).optional(),
});

export const CreateTaskSchema = z.object({
  name: z.string().trim().min(1).max(500),
  done: z.boolean().default(false),
});

export const UpdateTaskSchema = z.object({
  name: z.string().trim().min(1).max(500).optional(),
  done: z.boolean().optional(),
}).refine(
  data => data.name !== undefined || data.done !== undefined,
  { message: "At least one field must be provided" },
);

export const TaskListResponseSchema = createPaginatedResponseSchema(TaskSchema);

export type TaskDto = z.infer<typeof TaskSchema>;
export type ListTasksQuery = z.infer<typeof ListTasksQuerySchema>;
export type CreateTaskDto = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskDto = z.infer<typeof UpdateTaskSchema>;
