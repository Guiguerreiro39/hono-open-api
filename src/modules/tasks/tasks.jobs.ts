import type { QueuePort } from "@/core/ports/queue";
import { z } from "zod";

import { defineJob } from "@/core/ports/queue";

export const TasksAuditPayloadSchema = z.object({
  action: z.enum(["created", "updated", "deleted"]),
  taskId: z.uuid(),
  userId: z.string().min(1),
  actorId: z.string().min(1),
  taskName: z.string().min(1).optional(),
  done: z.boolean().optional(),
});

export type TasksAuditPayload = z.infer<typeof TasksAuditPayloadSchema>;

export const tasksAuditJob = defineJob({
  name: "tasks.audit",
  schema: TasksAuditPayloadSchema,
});

export function registerTasksJobs(queue: QueuePort): void {
  queue.registerHandler(tasksAuditJob, async (payload, ctx) => {
    ctx.logger.info(
      {
        action: payload.action,
        taskId: payload.taskId,
        userId: payload.userId,
        actorId: payload.actorId,
      },
      "Task audit recorded",
    );
  });
}
