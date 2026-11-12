import type { AuthPort } from "@/core/ports/auth";
import type { QueuePort } from "@/core/ports/queue";
import { z } from "zod";

import { defineJob } from "@/core/ports/queue";

export const AUTH_PRUNE_EXPIRED_SCHEDULER_ID = "auth.pruneExpired";
export const AUTH_PRUNE_EXPIRED_CRON = "0 3 * * *";

export const AuthPruneExpiredPayloadSchema = z.object({});

export type AuthPruneExpiredPayload = z.infer<typeof AuthPruneExpiredPayloadSchema>;

export const authPruneExpiredJob = defineJob({
  name: "auth.pruneExpired",
  schema: AuthPruneExpiredPayloadSchema,
});

export interface AuthJobsDeps {
  auth: Pick<AuthPort, "pruneExpired">;
}

export function registerAuthJobs(queue: QueuePort, deps: AuthJobsDeps): void {
  queue.registerHandler(authPruneExpiredJob, async (_payload, ctx) => {
    const result = await deps.auth.pruneExpired();
    ctx.logger.info(result, "Pruned expired auth sessions and verifications");
  });
}

export async function registerAuthSchedules(queue: QueuePort): Promise<void> {
  await queue.upsertSchedule(
    AUTH_PRUNE_EXPIRED_SCHEDULER_ID,
    { pattern: AUTH_PRUNE_EXPIRED_CRON, tz: "UTC" },
    { job: authPruneExpiredJob, data: {} },
  );
}
