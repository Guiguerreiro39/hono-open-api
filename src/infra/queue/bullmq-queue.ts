import type { ConnectionOptions, Job, JobsOptions, RepeatOptions } from "bullmq";
import type { Redis } from "ioredis";
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
import type { RedisClientHandle } from "@/infra/redis/client";
import { Queue, UnrecoverableError, Worker } from "bullmq";

import {
  createTraceContext,
  formatTraceparent,
  runWithTraceContext,
} from "@/core/observability/trace";
import {
  DEFAULT_JOB_ATTEMPTS,
  DEFAULT_JOB_BACKOFF_MS,
  DEFAULT_REMOVE_ON_COMPLETE,
  DEFAULT_REMOVE_ON_FAIL,
  isJobDefinition,
  isUnrecoverableJobError,
  JobPayloadValidationError,
  parseJobPayload,
  resolveScheduleTemplate,
  unwrapQueueEnvelope,
  validateJobId,
  wrapQueueEnvelope,
} from "@/core/ports/queue";
import { createRedisClient } from "@/infra/redis/client";

export const BULLMQ_QUEUE_NAME = "jobs";
export const DEFAULT_WORKER_CONCURRENCY = 5;
export const DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS = 10_000;

export function buildBullMQPrefix(prefix: string): string {
  return `${prefix}:bull`;
}

export interface BullMQQueueAdapterOptions extends QueueLifecycleHooks {
  redisUrl: string;
  prefix?: string;
  logger: Logger;
  metrics?: MetricsPort;
  worker?: boolean;
  concurrency?: number;
  shutdownTimeoutMs?: number;
}

export class BullMQQueueAdapter implements QueuePort {
  readonly queueName = BULLMQ_QUEUE_NAME;
  readonly prefix: string;
  readonly workerConcurrency: number;

  private readonly redisUrl: string;
  private readonly logger: Logger;
  private readonly metrics?: MetricsPort;
  private readonly hooks: QueueLifecycleHooks;
  private readonly shutdownTimeoutMs: number;
  private readonly handlers = new Map<string, JobHandler>();
  private readonly schemas = new Map<string, z.ZodType>();

  private readonly producerHandle: RedisClientHandle;
  private readonly queue: Queue;
  private workerHandle?: RedisClientHandle;
  private worker?: Worker;
  private closed = false;
  private forced = false;
  private workerClosePromise: Promise<void> | null = null;
  private closePromise: Promise<void> | null = null;

  constructor(options: BullMQQueueAdapterOptions) {
    this.redisUrl = options.redisUrl;
    this.prefix = buildBullMQPrefix(options.prefix ?? "app");
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.workerConcurrency = options.concurrency ?? DEFAULT_WORKER_CONCURRENCY;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_WORKER_SHUTDOWN_TIMEOUT_MS;
    this.hooks = {
      onJobComplete: options.onJobComplete,
      onJobFailed: options.onJobFailed,
    };

    // Fail-fast producer connection for HTTP / enqueue paths.
    this.producerHandle = createRedisClient({
      url: this.redisUrl,
      logger: this.logger,
      connectionName: "bullmq-producer",
      enableOfflineQueue: false,
      maxRetriesPerRequest: 2,
    });

    this.queue = new Queue(BULLMQ_QUEUE_NAME, {
      connection: this.producerHandle.client as unknown as ConnectionOptions,
      prefix: this.prefix,
      defaultJobOptions: {
        attempts: DEFAULT_JOB_ATTEMPTS,
        backoff: {
          type: "exponential",
          delay: DEFAULT_JOB_BACKOFF_MS,
        },
        removeOnComplete: DEFAULT_REMOVE_ON_COMPLETE,
        removeOnFail: DEFAULT_REMOVE_ON_FAIL,
      },
    });
    this.queue.on("error", (err) => {
      this.logger.warn({ err }, "BullMQ queue error");
    });

    if (options.worker) {
      this.startWorker();
    }
  }

  get producerClient(): Redis {
    return this.producerHandle.client;
  }

  get workerClient(): Redis | undefined {
    return this.workerHandle?.client;
  }

  /**
   * Starts the BullMQ Worker on a dedicated `maxRetriesPerRequest: null` Redis connection.
   * Idempotent if already started.
   */
  startWorker(): void {
    if (this.closed || this.worker) {
      return;
    }

    this.workerHandle = createRedisClient({
      url: this.redisUrl,
      logger: this.logger,
      connectionName: "bullmq-worker",
      enableOfflineQueue: true,
      maxRetriesPerRequest: null,
    });

    this.worker = new Worker(
      BULLMQ_QUEUE_NAME,
      job => this.processJob(job),
      {
        connection: this.workerHandle.client as unknown as ConnectionOptions,
        prefix: this.prefix,
        concurrency: this.workerConcurrency,
        removeOnComplete: DEFAULT_REMOVE_ON_COMPLETE,
        removeOnFail: DEFAULT_REMOVE_ON_FAIL,
      },
    );
    this.worker.on("error", (err) => {
      this.logger.warn({ err }, "BullMQ worker error");
    });
  }

  isWorkerRunning(): boolean {
    return this.worker ? this.worker.isRunning() : false;
  }

  private async ensureProducerReady(): Promise<void> {
    if (this.producerHandle.client.status !== "ready") {
      await this.producerHandle.ping();
    }
  }

  enqueue: QueuePort["enqueue"] = async (
    jobOrName: JobDefinition | string,
    data: unknown,
    opts?: EnqueueOptions,
  ): Promise<string> => {
    if (this.closed) {
      throw new Error("BullMQQueueAdapter is closed");
    }

    validateJobId(opts?.jobId);

    const jobName = isJobDefinition(jobOrName) ? jobOrName.name : jobOrName;
    const schema = isJobDefinition(jobOrName)
      ? jobOrName.schema
      : this.schemas.get(jobName);

    const validatedData = parseJobPayload(jobName, "enqueue", schema, data);
    await this.ensureProducerReady();
    const envelope = wrapQueueEnvelope(validatedData, formatTraceparent());

    const bullOpts: JobsOptions = {
      ...(opts?.jobId !== undefined ? { jobId: opts.jobId } : {}),
      ...(opts?.delayMs !== undefined ? { delay: opts.delayMs } : {}),
      ...(opts?.attempts !== undefined ? { attempts: opts.attempts } : {}),
      ...(opts?.backoffMs !== undefined
        ? { backoff: { type: "exponential", delay: opts.backoffMs } }
        : {}),
    };

    const job = await this.queue.add(jobName, envelope, bullOpts);
    return job.id ?? opts?.jobId ?? "";
  };

  /**
   * Direct access to the underlying BullMQ Queue for integration inspection (e.g. raw add, getJob).
   */
  getRawQueue(): Queue {
    return this.queue;
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
      throw new Error("BullMQQueueAdapter is closed");
    }

    const { name, validatedData, opts } = resolveScheduleTemplate(template, this.schemas);
    await this.ensureProducerReady();
    const envelope = wrapQueueEnvelope(validatedData);

    const repeatOpts: Omit<RepeatOptions, "key"> = {
      ...(schedule.pattern !== undefined ? { pattern: schedule.pattern } : {}),
      ...(schedule.every !== undefined ? { every: schedule.every } : {}),
      ...(schedule.tz !== undefined ? { tz: schedule.tz } : {}),
      ...(schedule.limit !== undefined ? { limit: schedule.limit } : {}),
      ...(schedule.startDate !== undefined ? { startDate: schedule.startDate } : {}),
      ...(schedule.endDate !== undefined ? { endDate: schedule.endDate } : {}),
    };

    const templateOpts = opts
      ? {
          ...(opts.attempts !== undefined ? { attempts: opts.attempts } : {}),
          ...(opts.backoffMs !== undefined
            ? { backoff: { type: "exponential", delay: opts.backoffMs } }
            : {}),
        }
      : undefined;

    await this.queue.upsertJobScheduler(schedulerId, repeatOpts, {
      name,
      data: envelope,
      ...(templateOpts && Object.keys(templateOpts).length > 0 ? { opts: templateOpts } : {}),
    });
  };

  async removeSchedule(schedulerId: string): Promise<boolean> {
    if (this.closed) {
      throw new Error("BullMQQueueAdapter is closed");
    }
    await this.ensureProducerReady();
    return this.queue.removeJobScheduler(schedulerId);
  }

  async ping(): Promise<void> {
    if (this.closed) {
      throw new Error("BullMQQueueAdapter is closed");
    }
    await this.producerHandle.ping();
  }

  private async processJob(job: Job): Promise<void> {
    const { payload, traceparent } = unwrapQueueEnvelope(job.data);
    const jobId = job.id ?? "unknown";
    const jobName = job.name;
    const attempt = job.attemptsMade + 1;
    const traceCtx = createTraceContext(traceparent);
    const startedAt = performance.now();

    try {
      await runWithTraceContext(traceCtx, async () => {
        const jobLogger = this.logger.child({
          jobId,
          jobName,
          attempt,
          trace_id: traceCtx.traceId,
        });

        const handler = this.handlers.get(jobName);
        if (!handler) {
          throw new UnrecoverableError(`No handler registered for job '${jobName}'`);
        }

        const schema = this.schemas.get(jobName);
        let validatedPayload: unknown;
        try {
          validatedPayload = parseJobPayload(jobName, "execution", schema, payload);
        }
        catch (err) {
          if (err instanceof JobPayloadValidationError) {
            throw new UnrecoverableError(err.message);
          }
          throw err;
        }

        const ctx: JobContext = {
          jobId,
          jobName,
          attempt,
          logger: jobLogger,
          traceId: traceCtx.traceId,
          spanId: traceCtx.spanId,
        };

        await handler(validatedPayload, ctx);
      });

      const durationMs = performance.now() - startedAt;
      this.metrics?.recordJob({
        name: jobName,
        status: "completed",
        durationSeconds: durationMs / 1000,
      });
      await this.hooks.onJobComplete?.({
        jobId,
        jobName,
        attempt,
        durationMs,
        traceId: traceCtx.traceId,
      });
    }
    catch (err) {
      const durationMs = performance.now() - startedAt;
      const unrecoverable = err instanceof UnrecoverableError || isUnrecoverableJobError(err);
      const thrown = unrecoverable && !(err instanceof UnrecoverableError)
        ? new UnrecoverableError(err instanceof Error ? err.message : String(err))
        : err;

      this.metrics?.recordJob({
        name: jobName,
        status: "failed",
        durationSeconds: durationMs / 1000,
      });
      await this.hooks.onJobFailed?.({
        jobId,
        jobName,
        attempt,
        durationMs,
        traceId: traceCtx.traceId,
        error: thrown,
        unrecoverable,
      });

      this.logger.error(
        {
          err: thrown,
          jobId,
          jobName,
          attempt,
          trace_id: traceCtx.traceId,
          span_id: traceCtx.spanId,
          unrecoverable,
        },
        "Background job failed",
      );

      throw thrown;
    }
  }

  private async closeWorkerGracefully(): Promise<void> {
    if (!this.worker) {
      return;
    }

    const activeWorker = this.worker;
    if (this.workerHandle && this.workerHandle.client.status !== "ready") {
      await this.workerHandle.quit();
      await activeWorker.close(true).catch(() => {});
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        activeWorker.close(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            this.logger.warn(
              { timeoutMs: this.shutdownTimeoutMs },
              "Worker shutdown timed out; forcing close",
            );
            void activeWorker.close(true).then(resolve, resolve);
          }, this.shutdownTimeoutMs);
          timer.unref?.();
        }),
      ]);
    }
    catch (err) {
      this.logger.warn({ err }, "Error closing BullMQ worker");
    }
    finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  closeWorker(): Promise<void> {
    if (this.workerClosePromise) {
      return this.workerClosePromise;
    }
    this.workerClosePromise = this.closeWorkerGracefully().then(async () => {
      await this.workerHandle?.quit();
    });
    return this.workerClosePromise;
  }

  forceClose(): void {
    this.closed = true;
    this.forced = true;
    if (this.worker) {
      void this.worker.close(true).catch(() => {});
    }
    this.workerHandle?.client.disconnect();
    this.producerHandle.client.disconnect();
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.closePromise = (async () => {
      if (!this.forced) {
        await this.closeWorker();
      }
      if (this.producerHandle.client.status !== "ready") {
        await this.producerHandle.quit();
      }
      await this.queue.close().catch(() => {});
      await this.producerHandle.quit();
    })();
    return this.closePromise;
  }
}
