import type { FileRepository } from "./files.repository";
import type { QueuePort } from "@/core/ports/queue";
import type { StoragePort } from "@/core/ports/storage";
import { z } from "zod";

import { defineJob } from "@/core/ports/queue";

export const FILES_PRUNE_PENDING_SCHEDULER_ID = "files.prunePending";
export const FILES_PRUNE_PENDING_CRON = "0 * * * *";

export const FilesDeleteObjectPayloadSchema = z.object({
  key: z.string().min(1),
});

export type FilesDeleteObjectPayload = z.infer<typeof FilesDeleteObjectPayloadSchema>;

export const filesDeleteObjectJob = defineJob({
  name: "files.deleteObject",
  schema: FilesDeleteObjectPayloadSchema,
});

export const FilesPrunePendingPayloadSchema = z.object({});

export type FilesPrunePendingPayload = z.infer<typeof FilesPrunePendingPayloadSchema>;

export const filesPrunePendingJob = defineJob({
  name: "files.prunePending",
  schema: FilesPrunePendingPayloadSchema,
});

export interface FilesJobsDeps {
  storage: StoragePort;
  fileRepository: FileRepository;
}

export function registerFilesJobs(queue: QueuePort, deps: FilesJobsDeps): void {
  queue.registerHandler(filesDeleteObjectJob, async (payload, ctx) => {
    await deps.storage.delete(payload.key);
    ctx.logger.info({ key: payload.key }, "Deleted orphaned storage object");
  });

  queue.registerHandler(filesPrunePendingJob, async (_payload, ctx) => {
    const expired = await deps.fileRepository.deleteExpiredPending(new Date());

    for (const record of expired) {
      try {
        await deps.storage.delete(record.key);
      }
      catch (err) {
        ctx.logger.warn(
          { err, fileId: record.id, key: record.key },
          "Failed to delete expired pending object; enqueueing cleanup retry",
        );
        await queue.enqueue(filesDeleteObjectJob, { key: record.key });
      }
    }

    ctx.logger.info({ prunedCount: expired.length }, "Pruned expired pending files");
  });
}

export async function registerFilesSchedules(queue: QueuePort): Promise<void> {
  await queue.upsertSchedule(
    FILES_PRUNE_PENDING_SCHEDULER_ID,
    { pattern: FILES_PRUNE_PENDING_CRON, tz: "UTC" },
    { job: filesPrunePendingJob, data: {} },
  );
}
