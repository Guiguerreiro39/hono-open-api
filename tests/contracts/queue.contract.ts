import type { EnqueueOptions, JobContext, QueuePort } from "@/core/ports/queue";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { defineJob } from "@/core/ports/queue";

export interface QueueContractHarness {
  queue: QueuePort;
  flush: () => Promise<void>;
  enqueueRaw: (name: string, payload: unknown, opts?: EnqueueOptions) => Promise<string>;
  cleanup: () => Promise<void>;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

export function defineQueueContract(
  suiteName: string,
  createHarness: () => Promise<QueueContractHarness>,
) {
  describe(`QueuePort contract (${suiteName})`, () => {
    const cleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
      while (cleanups.length > 0) {
        await cleanups.pop()?.();
      }
    });

    it("enqueues typed defineJob payloads, rejects invalid enqueue payloads, and executes registered handlers", async () => {
      const harness = await createHarness();
      cleanups.push(harness.cleanup);
      const { queue, flush } = harness;

      const emailJob = defineJob({
        name: "contract.email",
        schema: z.object({
          to: z.email(),
          count: z.number().int().positive().default(1),
        }),
      });

      const received: Array<{ data: { to: string; count: number }; ctx: JobContext }> = [];
      queue.registerHandler(emailJob, async (data, ctx) => {
        received.push({ data, ctx });
      });

      await expect(
        queue.enqueue(emailJob, { to: "not-an-email" }),
      ).rejects.toThrow();

      const jobId = await queue.enqueue(
        emailJob,
        { to: "alice@example.com" },
        { jobId: "email-dedup-1" },
      );
      expect(jobId).toBe("email-dedup-1");

      await flush();
      await waitUntil(() => received.length === 1);

      expect(received[0].data).toEqual({ to: "alice@example.com", count: 1 });
      expect(received[0].ctx.jobId).toBe("email-dedup-1");
      expect(received[0].ctx.jobName).toBe("contract.email");
      expect(received[0].ctx.attempt).toBe(1);
      expect(received[0].ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    });

    it("rejects jobId overrides containing colons or empty strings", async () => {
      const harness = await createHarness();
      cleanups.push(harness.cleanup);
      const { queue } = harness;

      const sampleJob = defineJob({
        name: "contract.sample",
        schema: z.object({ id: z.string() }),
      });

      await expect(
        queue.enqueue(sampleJob, { id: "1" }, { jobId: "bad:job:id" }),
      ).rejects.toThrow(/:/);

      await expect(
        queue.enqueue(sampleJob, { id: "1" }, { jobId: "" }),
      ).rejects.toThrow();
    });

    it("fails unrecoverably without retries when execution payload fails Zod validation", async () => {
      const harness = await createHarness();
      cleanups.push(harness.cleanup);
      const { queue, flush, enqueueRaw } = harness;

      const strictJob = defineJob({
        name: "contract.strict",
        schema: z.object({
          taskId: z.uuid(),
        }),
      });

      let handlerCalls = 0;
      queue.registerHandler(strictJob, async () => {
        handlerCalls += 1;
      });

      await enqueueRaw("contract.strict", { taskId: "not-a-uuid" }, { attempts: 3 });

      await flush();
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(handlerCalls).toBe(0);
    });

    it("upserts and removes idempotent schedules and succeeds on ping()", async () => {
      const harness = await createHarness();
      cleanups.push(harness.cleanup);
      const { queue } = harness;

      await queue.ping();

      const cronJob = defineJob({
        name: "contract.cron",
        schema: z.object({ tag: z.string() }),
      });

      await queue.upsertSchedule(
        "contract.cron.daily",
        { pattern: "0 3 * * *", tz: "UTC" },
        { job: cronJob, data: { tag: "first" } },
      );

      // Idempotent update with the same schedulerId
      await queue.upsertSchedule(
        "contract.cron.daily",
        { pattern: "0 4 * * *", tz: "UTC" },
        { job: cronJob, data: { tag: "second" } },
      );

      expect(await queue.removeSchedule("contract.cron.daily")).toBe(true);
      expect(await queue.removeSchedule("contract.cron.daily")).toBe(false);
    });
  });
}
