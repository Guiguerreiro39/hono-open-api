import type { Logger } from "pino";
import type { z } from "zod";
import type { MetricsPort } from "@/core/ports/metrics";
import type {
  EnqueueOptions,
  JobContext,
  JobDefinition,
  JobHandler,
  QueueLifecycleHooks,
  QueuePort,
  QueueScheduleDefinitionTemplate,
  QueueScheduleOptions,
  QueueScheduleTemplate,
} from "@/core/ports/queue";

import {
  createTraceContext,
  formatTraceparent,
  runWithTraceContext,
} from "@/core/observability/trace";
import {
  DEFAULT_JOB_ATTEMPTS,
  isJobDefinition,
  isUnrecoverableJobError,
  parseJobPayload,
  resolveScheduleTemplate,
  validateJobId,
} from "@/core/ports/queue";

export type MemoryQueueMode = "buffered" | "auto";

export interface MemoryQueueJobRecord {
  id: string;
  name: string;
  data: unknown;
  opts?: EnqueueOptions;
  traceparent?: string;
  status: "waiting" | "completed" | "failed";
  attemptsMade: number;
  maxAttempts: number;
  error?: Error;
}

export interface MemoryQueueScheduleRecord {
  schedulerId: string;
  schedule: QueueScheduleOptions;
  template: QueueScheduleTemplate;
}

export interface MemoryQueueAdapterOptions extends QueueLifecycleHooks {
  mode?: MemoryQueueMode;
  logger: Logger;
  metrics?: MetricsPort;
}

export class MemoryQueueAdapter implements QueuePort {
  readonly mode: MemoryQueueMode;

  private readonly logger: Logger;
  private readonly metrics?: MetricsPort;
  private readonly hooks: QueueLifecycleHooks;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly schemas = new Map<string, z.ZodType>();
  private readonly jobs: MemoryQueueJobRecord[] = [];
  private readonly jobIds = new Set<string>();
  private readonly schedules = new Map<string, MemoryQueueScheduleRecord>();

  private microtaskScheduled = false;
  private drainingPromise: Promise<void> | null = null;
  private closed = false;

  constructor(options: MemoryQueueAdapterOptions) {
    this.mode = options.mode ?? "buffered";
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.hooks = {
      onJobComplete: options.onJobComplete,
      onJobFailed: options.onJobFailed,
    };
  }

  enqueue: QueuePort["enqueue"] = async (
    jobOrName: JobDefinition | string,
    data: unknown,
    opts?: EnqueueOptions,
  ): Promise<string> => {
    if (this.closed) {
      throw new Error("MemoryQueueAdapter is closed");
    }

    validateJobId(opts?.jobId);

    const jobName = isJobDefinition(jobOrName) ? jobOrName.name : jobOrName;
    const schema = isJobDefinition(jobOrName)
      ? jobOrName.schema
      : this.schemas.get(jobName);

    const validatedData = parseJobPayload(jobName, "enqueue", schema, data);
    return this.pushJob(jobName, validatedData, opts);
  };

  /**
   * Inserts an unvalidated payload directly into the buffer (used by contract suites
   * to test execution-time Zod validation and UnrecoverableError handling).
   */
  async enqueueRaw(name: string, payload: unknown, opts?: EnqueueOptions): Promise<string> {
    if (this.closed) {
      throw new Error("MemoryQueueAdapter is closed");
    }
    validateJobId(opts?.jobId);
    return this.pushJob(name, payload, opts);
  }

  private pushJob(name: string, payload: unknown, opts?: EnqueueOptions): string {
    const id = opts?.jobId ?? crypto.randomUUID();
    if (this.jobIds.has(id)) {
      return id;
    }

    this.jobIds.add(id);
    this.jobs.push({
      id,
      name,
      data: payload,
      opts,
      traceparent: formatTraceparent(),
      status: "waiting",
      attemptsMade: 0,
      maxAttempts: opts?.attempts ?? DEFAULT_JOB_ATTEMPTS,
    });

    if (this.mode === "auto" && !this.microtaskScheduled) {
      this.microtaskScheduled = true;
      queueMicrotask(() => {
        this.microtaskScheduled = false;
        if (!this.closed) {
          void this.drain();
        }
      });
    }

    return id;
  }

  registerHandler: QueuePort["registerHandler"] = (
    jobOrName: JobDefinition | string,
    handler: JobHandler<any>,
  ): void => {
    if (isJobDefinition(jobOrName)) {
      this.schemas.set(jobOrName.name, jobOrName.schema);
      this.handlers.set(jobOrName.name, handler);
      return;
    }
    this.handlers.set(jobOrName, handler);
  };

  upsertSchedule: QueuePort["upsertSchedule"] = async (
    schedulerId: string,
    schedule: QueueScheduleOptions,
    template: QueueScheduleTemplate | QueueScheduleDefinitionTemplate,
  ): Promise<void> => {
    if (this.closed) {
      throw new Error("MemoryQueueAdapter is closed");
    }

    const { name, validatedData, opts } = resolveScheduleTemplate(template, this.schemas);

    this.schedules.set(schedulerId, {
      schedulerId,
      schedule: { ...schedule },
      template: {
        name,
        data: validatedData,
        opts,
      },
    });
  };

  async removeSchedule(schedulerId: string): Promise<boolean> {
    return this.schedules.delete(schedulerId);
  }

  async ping(): Promise<void> {
    if (this.closed) {
      throw new Error("MemoryQueueAdapter is closed");
    }
  }

  isWorkerRunning(): boolean {
    return !this.closed;
  }

  async drain(): Promise<void> {
    if (this.drainingPromise) {
      return this.drainingPromise;
    }

    this.drainingPromise = this.runDrainLoop().finally(() => {
      this.drainingPromise = null;
    });
    return this.drainingPromise;
  }

  private async runDrainLoop(): Promise<void> {
    while (true) {
      const nextJob = this.jobs.find(job => job.status === "waiting");
      if (!nextJob) {
        break;
      }
      await this.executeJob(nextJob);
    }
  }

  private async executeJob(record: MemoryQueueJobRecord): Promise<void> {
    while (record.status === "waiting" && record.attemptsMade < record.maxAttempts) {
      record.attemptsMade += 1;
      const attempt = record.attemptsMade;
      const traceCtx = createTraceContext(record.traceparent);
      const startedAt = performance.now();

      try {
        await runWithTraceContext(traceCtx, async () => {
          const jobLogger = this.logger.child({
            jobId: record.id,
            jobName: record.name,
            attempt,
            trace_id: traceCtx.traceId,
          });

          const handler = this.handlers.get(record.name);
          if (!handler) {
            throw new Error(`No handler registered for job '${record.name}'`);
          }

          const schema = this.schemas.get(record.name);
          const validatedPayload = parseJobPayload(record.name, "execution", schema, record.data);

          const ctx: JobContext = {
            jobId: record.id,
            jobName: record.name,
            attempt,
            logger: jobLogger,
            traceId: traceCtx.traceId,
            spanId: traceCtx.spanId,
          };

          await handler(validatedPayload, ctx);
        });

        const durationMs = performance.now() - startedAt;
        record.status = "completed";
        this.metrics?.recordJob({
          name: record.name,
          status: "completed",
          durationSeconds: durationMs / 1000,
        });
        await this.hooks.onJobComplete?.({
          jobId: record.id,
          jobName: record.name,
          attempt,
          durationMs,
          traceId: traceCtx.traceId,
        });
      }
      catch (err) {
        const durationMs = performance.now() - startedAt;
        const unrecoverable = isUnrecoverableJobError(err);
        const errorObj = err instanceof Error ? err : new Error(String(err));
        record.error = errorObj;

        this.metrics?.recordJob({
          name: record.name,
          status: "failed",
          durationSeconds: durationMs / 1000,
        });
        await this.hooks.onJobFailed?.({
          jobId: record.id,
          jobName: record.name,
          attempt,
          durationMs,
          traceId: traceCtx.traceId,
          error: err,
          unrecoverable,
        });

        this.logger.error(
          {
            err: errorObj,
            jobId: record.id,
            jobName: record.name,
            attempt,
            trace_id: traceCtx.traceId,
            span_id: traceCtx.spanId,
            unrecoverable,
          },
          "Background job failed",
        );

        if (unrecoverable || record.attemptsMade >= record.maxAttempts) {
          record.status = "failed";
          break;
        }
      }
    }
  }

  getJobs(): readonly MemoryQueueJobRecord[] {
    return this.jobs.map(job => ({ ...job }));
  }

  getSchedules(): readonly MemoryQueueScheduleRecord[] {
    return Array.from(this.schedules.values()).map(entry => ({
      schedulerId: entry.schedulerId,
      schedule: { ...entry.schedule },
      template: { ...entry.template },
    }));
  }

  clear(): void {
    this.jobs.length = 0;
    this.jobIds.clear();
    this.schedules.clear();
  }

  async close(): Promise<void> {
    if (this.drainingPromise) {
      await this.drainingPromise;
    }
    this.closed = true;
  }
}
