import type { MiddlewareHandler } from "hono";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

const TRACEPARENT_REGEX = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "0".repeat(32);
const ZERO_SPAN_ID = "0".repeat(16);

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags: string;
}

export interface ParsedTraceparent {
  version: string;
  traceId: string;
  parentSpanId: string;
  traceFlags: string;
}

const traceStorage = new AsyncLocalStorage<TraceContext>();

function generateNonZeroHex(byteLength: number, allZeroHex: string): string {
  let value = randomBytes(byteLength).toString("hex");
  while (value === allZeroHex) {
    value = randomBytes(byteLength).toString("hex");
  }
  return value;
}

export function generateTraceId(): string {
  return generateNonZeroHex(16, ZERO_TRACE_ID);
}

export function generateSpanId(): string {
  return generateNonZeroHex(8, ZERO_SPAN_ID);
}

export function parseTraceparent(header: string | null | undefined): ParsedTraceparent | null {
  if (!header) {
    return null;
  }

  const match = TRACEPARENT_REGEX.exec(header.trim());
  if (!match) {
    return null;
  }

  const [, version, traceId, parentSpanId, traceFlags] = match;
  if (version === "ff" || traceId === ZERO_TRACE_ID || parentSpanId === ZERO_SPAN_ID) {
    return null;
  }

  return {
    version,
    traceId,
    parentSpanId,
    traceFlags,
  };
}

export function createTraceContext(traceparentHeader?: string | null): TraceContext {
  const parsed = parseTraceparent(traceparentHeader);
  if (parsed) {
    return {
      traceId: parsed.traceId,
      spanId: generateSpanId(),
      parentSpanId: parsed.parentSpanId,
      traceFlags: parsed.traceFlags,
    };
  }

  return {
    traceId: generateTraceId(),
    spanId: generateSpanId(),
    traceFlags: "01",
  };
}

export function getTraceContext(): TraceContext | undefined {
  return traceStorage.getStore();
}

export function runWithTraceContext<T>(ctx: TraceContext, fn: () => T): T {
  return traceStorage.run(ctx, fn);
}

export function formatTraceparent(ctx: TraceContext): string;
export function formatTraceparent(ctx?: TraceContext): string | undefined;
export function formatTraceparent(ctx: TraceContext | undefined = getTraceContext()): string | undefined {
  if (!ctx) {
    return undefined;
  }
  return `00-${ctx.traceId}-${ctx.spanId}-${ctx.traceFlags}`;
}

export function traceContext(): MiddlewareHandler {
  return (c, next) => {
    const ctx = createTraceContext(c.req.header("traceparent"));
    return traceStorage.run(ctx, () => next());
  };
}
