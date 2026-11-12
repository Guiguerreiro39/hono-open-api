import { z } from "@hono/zod-openapi";

export const RootResponseSchema = z.object({
  name: z.string(),
  status: z.literal("ok"),
});

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  timestamp: z.iso.datetime(),
});

export const ProbeCheckSchema = z.object({
  status: z.enum(["ok", "error", "skipped"]),
  latencyMs: z.number().optional(),
  message: z.string().optional(),
});

export const ReadinessChecksSchema = z.object({
  db: ProbeCheckSchema,
  redis: ProbeCheckSchema,
});

export const ReadyOkResponseSchema = z.object({
  status: z.enum(["ok", "degraded"]),
  timestamp: z.iso.datetime(),
  checks: ReadinessChecksSchema,
});

export const ReadyUnhealthyResponseSchema = z.object({
  status: z.literal("unhealthy"),
  timestamp: z.iso.datetime(),
  checks: ReadinessChecksSchema,
});

export type ProbeCheck = z.infer<typeof ProbeCheckSchema>;
