import type { Logger } from "pino";
import type { z } from "zod";

export const DEFAULT_JOB_ATTEMPTS = 3;
export const DEFAULT_JOB_BACKOFF_MS = 1000;
export const DEFAULT_REMOVE_ON_COMPLETE = { age: 86_400, count: 1000 } as const;
export const DEFAULT_REMOVE_ON_FAIL = { age: 604_800, count: 5000 } as const;

export interface JobDefinition<
  TName extends string = string,
  TSchema extends z.ZodType = z.ZodType,
> {
  readonly name: TName;
  readonly schema: TSchema;
}

/**
 * Defines a typed background job contract with a unique name and Zod payload schema.
 */
export function defineJob<TName extends string, TSchema extends z.ZodType>(definition: {
  name: TName;
  schema: TSchema;
}): JobDefinition<TName, TSchema> {
  if (!definition.name || definition.name.includes(":")) {
    throw new Error("Job name must be a non-empty string without ':'");
  }
  return Object.freeze({ ...definition });
}

export function isJobDefinition(value: unknown): value is JobDefinition {
  return (
    typeof value === "object"
    && value !== null
    && "name" in value
    && "schema" in value
    && typeof (value as JobDefinition).name === "string"
    && typeof (value as JobDefinition).schema?.safeParse === "function"
  );
}

export interface EnqueueOptions {
  delayMs?: number;
  attempts?: number;
  backoffMs?: number;
  jobId?: string;
}

export interface QueueScheduleOptions {
  pattern?: string;
  every?: number;
  tz?: string;
  limit?: number;
  startDate?: Date | string | number;
  endDate?: Date | string | number;
}

export interface QueueScheduleTemplateOptions {
  attempts?: number;
  backoffMs?: number;
}

export interface QueueScheduleTemplate<TData = unknown> {
  name: string;
  data: TData;
  opts?: QueueScheduleTemplateOptions;
}

export interface QueueScheduleDefinitionTemplate<
  TName extends string = string,
  TSchema extends z.ZodType = z.ZodType,
> {
  job: JobDefinition<TName, TSchema>;
  data: z.input<TSchema>;
  opts?: QueueScheduleTemplateOptions;
}

export interface JobContext {
  jobId: string;
  jobName: string;
  attempt: number;
  logger: Logger;
  traceId: string;
  spanId: string;
  signal?: AbortSignal;
}

export type JobHandler<TData = unknown> = (data: TData, ctx: JobContext) => Promise<void>;

export interface JobCompleteEvent {
  jobId: string;
  jobName: string;
  attempt: number;
  durationMs: number;
  traceId: string;
}

export interface JobFailedEvent extends JobCompleteEvent {
  error: unknown;
  unrecoverable: boolean;
}

export interface QueueLifecycleHooks {
  onJobComplete?: (event: JobCompleteEvent) => void | Promise<void>;
  onJobFailed?: (event: JobFailedEvent) => void | Promise<void>;
}

/**
 * Thrown when a job payload fails Zod validation on enqueue or execution.
 * Marked with `name = "UnrecoverableError"` so workers never retry malformed payloads.
 */
export class JobPayloadValidationError extends Error {
  readonly jobName: string;
  readonly phase: "enqueue" | "execution";
  readonly issues: z.core.$ZodIssue[];
  readonly isUnrecoverable = true;

  constructor(jobName: string, phase: "enqueue" | "execution", error: z.ZodError) {
    super(`Invalid payload for job '${jobName}' during ${phase}: ${error.message}`);
    this.name = "UnrecoverableError";
    this.jobName = jobName;
    this.phase = phase;
    this.issues = error.issues;
  }
}

export function isUnrecoverableJobError(err: unknown): boolean {
  return (
    err instanceof Error
    && (err.name === "UnrecoverableError"
      || (err as { isUnrecoverable?: boolean }).isUnrecoverable === true)
  );
}

/**
 * Validates caller-supplied deterministic jobId overrides (BullMQ disallows ':').
 */
export function validateJobId(jobId: string | undefined): void {
  if (jobId === undefined) {
    return;
  }
  if (jobId.length === 0 || jobId.includes(":")) {
    throw new Error("Job ID must be a non-empty string without ':'");
  }
}

export interface QueueEnvelope {
  __queueEnvelope: true;
  payload: unknown;
  traceparent?: string;
}

export function wrapQueueEnvelope(payload: unknown, traceparent?: string): QueueEnvelope {
  return traceparent !== undefined
    ? { __queueEnvelope: true, payload, traceparent }
    : { __queueEnvelope: true, payload };
}

export function unwrapQueueEnvelope(raw: unknown): { payload: unknown; traceparent?: string } {
  if (
    typeof raw === "object"
    && raw !== null
    && "__queueEnvelope" in raw
    && (raw as QueueEnvelope).__queueEnvelope === true
    && "payload" in raw
  ) {
    const envelope = raw as QueueEnvelope;
    return {
      payload: envelope.payload,
      traceparent: typeof envelope.traceparent === "string" ? envelope.traceparent : undefined,
    };
  }
  return { payload: raw };
}

export function parseJobPayload(
  jobName: string,
  phase: "enqueue" | "execution",
  schema: z.ZodType | undefined,
  payload: unknown,
): unknown {
  if (!schema) {
    return payload;
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new JobPayloadValidationError(jobName, phase, parsed.error);
  }
  return parsed.data;
}

export function resolveScheduleTemplate(
  template: QueueScheduleTemplate | QueueScheduleDefinitionTemplate,
  schemas: ReadonlyMap<string, z.ZodType>,
): { name: string; validatedData: unknown; opts?: QueueScheduleTemplateOptions } {
  if ("job" in template) {
    const validatedData = parseJobPayload(
      template.job.name,
      "enqueue",
      template.job.schema,
      template.data,
    );
    return {
      name: template.job.name,
      validatedData,
      opts: template.opts,
    };
  }
  const validatedData = parseJobPayload(
    template.name,
    "enqueue",
    schemas.get(template.name),
    template.data,
  );
  return {
    name: template.name,
    validatedData,
    opts: template.opts,
  };
}

export interface QueuePort {
  enqueue: {
    <TName extends string, TSchema extends z.ZodType>(
      job: JobDefinition<TName, TSchema>,
      data: z.input<TSchema>,
      opts?: EnqueueOptions,
    ): Promise<string>;
    <TData = unknown>(
      name: string,
      data: TData,
      opts?: EnqueueOptions,
    ): Promise<string>;
  };
  registerHandler: {
    <TName extends string, TSchema extends z.ZodType>(
      job: JobDefinition<TName, TSchema>,
      handler: JobHandler<z.output<TSchema>>,
    ): void;
    <TData = unknown>(
      name: string,
      handler: JobHandler<TData>,
    ): void;
  };
  upsertSchedule: {
    <TName extends string, TSchema extends z.ZodType>(
      schedulerId: string,
      schedule: QueueScheduleOptions,
      template: QueueScheduleDefinitionTemplate<TName, TSchema>,
    ): Promise<void>;
    <TData = unknown>(
      schedulerId: string,
      schedule: QueueScheduleOptions,
      template: QueueScheduleTemplate<TData>,
    ): Promise<void>;
  };
  removeSchedule: (schedulerId: string) => Promise<boolean>;
  ping: () => Promise<void>;
  close: () => Promise<void>;
  closeWorker?: () => Promise<void>;
  forceClose?: () => void;
  drain?: () => Promise<void>;
  isWorkerRunning?: () => boolean;
}
