import type { MiddlewareHandler } from "hono";
import type { DestinationStream, Logger, LoggerOptions } from "pino";

import type { Env } from "@/env";
import { pinoLogger } from "hono-pino";
import pino from "pino";
import pretty from "pino-pretty";

import { getTraceContext } from "@/core/observability/trace";

const REDACT_PATHS = [
  "password",
  "token",
  "secret",
  "authorization",
  "cookie",
  "*.password",
  "*.token",
  "*.secret",
  "*.authorization",
  "*.cookie",
  "*.*.password",
  "*.*.token",
  "*.*.secret",
  "*.*.authorization",
  "*.*.cookie",
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers[\"set-cookie\"]",
  "headers[\"set-cookie\"]",
];

const PROBE_PATHS = new Set(["/health", "/ready", "/metrics"]);

export function createLogger(
  env: Pick<Env, "LOG_LEVEL" | "NODE_ENV">,
  destination?: DestinationStream,
): Logger {
  const options: LoggerOptions = {
    level: env.LOG_LEVEL,
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
    },
    mixin() {
      const trace = getTraceContext();
      if (!trace) {
        return {};
      }
      return {
        trace_id: trace.traceId,
        span_id: trace.spanId,
      };
    },
  };

  if (destination) {
    return pino(options, destination);
  }

  if (env.NODE_ENV === "development") {
    return pino(options, pretty());
  }

  return pino(options);
}

export function createHttpLogger(logger: Logger): MiddlewareHandler {
  return pinoLogger({
    pino: logger,
    http: {
      referRequestIdKey: "requestId",
      onReqBindings: c => ({
        req: {
          method: c.req.method,
          path: c.req.path,
        },
      }),
      onResBindings: c => ({
        res: {
          status: c.res.status,
        },
      }),
      onResLevel: (c) => {
        if (c.res.status >= 500) {
          return "error";
        }
        if (c.res.status >= 400) {
          return "warn";
        }
        if (PROBE_PATHS.has(c.req.path)) {
          return "debug";
        }
        return "info";
      },
    },
  });
}
