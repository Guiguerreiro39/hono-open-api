import type { OpenAPIHonoOptions } from "@hono/zod-openapi";
import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Logger } from "pino";

import type { AppBindings } from "./types";
import { z } from "@hono/zod-openapi";
import { HTTPException } from "hono/http-exception";

export interface AppErrorOptions {
  code?: string;
  details?: unknown;
  cause?: unknown;
}

export class AppError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly details?: unknown;

  constructor(options: {
    status: ContentfulStatusCode;
    code: string;
    message: string;
    details?: unknown;
    cause?: unknown;
  }) {
    super(options.message, { cause: options.cause });
    this.name = new.target.name;
    this.status = options.status;
    this.code = options.code;
    this.details = options.details;
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Bad request", options?: AppErrorOptions) {
    super({
      status: 400,
      code: options?.code ?? "BAD_REQUEST",
      message,
      details: options?.details,
      cause: options?.cause,
    });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Unauthorized", options?: AppErrorOptions) {
    super({
      status: 401,
      code: options?.code ?? "UNAUTHORIZED",
      message,
      details: options?.details,
      cause: options?.cause,
    });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "Forbidden", options?: AppErrorOptions) {
    super({
      status: 403,
      code: options?.code ?? "FORBIDDEN",
      message,
      details: options?.details,
      cause: options?.cause,
    });
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found", options?: AppErrorOptions) {
    super({
      status: 404,
      code: options?.code ?? "NOT_FOUND",
      message,
      details: options?.details,
      cause: options?.cause,
    });
  }
}

export class RequestTimeoutError extends AppError {
  constructor(message = "Request timeout", options?: AppErrorOptions) {
    super({
      status: 408,
      code: options?.code ?? "REQUEST_TIMEOUT",
      message,
      details: options?.details,
      cause: options?.cause,
    });
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict", options?: AppErrorOptions) {
    super({
      status: 409,
      code: options?.code ?? "CONFLICT",
      message,
      details: options?.details,
      cause: options?.cause,
    });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = "Payload too large", options?: AppErrorOptions) {
    super({
      status: 413,
      code: options?.code ?? "PAYLOAD_TOO_LARGE",
      message,
      details: options?.details,
      cause: options?.cause,
    });
  }
}

export class ValidationError extends AppError {
  constructor(message = "Validation failed", options?: AppErrorOptions) {
    super({
      status: 422,
      code: options?.code ?? "VALIDATION_ERROR",
      message,
      details: options?.details,
      cause: options?.cause,
    });
  }
}

export class RateLimitError extends AppError {
  constructor(message = "Too many requests", options?: AppErrorOptions) {
    super({
      status: 429,
      code: options?.code ?? "RATE_LIMIT_EXCEEDED",
      message,
      details: options?.details,
      cause: options?.cause,
    });
  }
}

export class ServiceUnavailableError extends AppError {
  constructor(message = "Service unavailable", options?: AppErrorOptions) {
    super({
      status: 503,
      code: options?.code ?? "SERVICE_UNAVAILABLE",
      message,
      details: options?.details,
      cause: options?.cause,
    });
  }
}

export const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.unknown().optional(),
  }),
});

const STATUS_DESCRIPTIONS: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  422: "Validation Error",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

const HTTP_EXCEPTION_CODES: Record<number, string> = {
  400: "BAD_REQUEST",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  408: "REQUEST_TIMEOUT",
  409: "CONFLICT",
  413: "PAYLOAD_TOO_LARGE",
  422: "VALIDATION_ERROR",
  429: "RATE_LIMIT_EXCEEDED",
  503: "SERVICE_UNAVAILABLE",
};

export interface ErrorResponseSpec {
  description: string;
  content: {
    "application/json": {
      schema: typeof ErrorResponseSchema;
    };
  };
}

export function createErrorResponses<const T extends readonly ContentfulStatusCode[]>(
  ...statuses: T
): { [K in T[number]]: ErrorResponseSpec } {
  const result: Record<number, ErrorResponseSpec> = {};
  for (const status of statuses) {
    result[status] = {
      description: STATUS_DESCRIPTIONS[status] ?? "Error",
      content: {
        "application/json": {
          schema: ErrorResponseSchema,
        },
      },
    };
  }
  return result as { [K in T[number]]: ErrorResponseSpec };
}

export function getRequestId(c: Context<AppBindings>): string {
  return c.get("requestId") ?? "unknown";
}

export const defaultHook: OpenAPIHonoOptions<AppBindings>["defaultHook"] = (result, c) => {
  if (!result.success) {
    return c.json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        requestId: getRequestId(c),
        details: result.error.issues,
      },
    }, 422);
  }
};

export const notFoundHandler: NotFoundHandler<AppBindings> = (c) => {
  return c.json({
    error: {
      code: "NOT_FOUND",
      message: "Not found",
      requestId: getRequestId(c),
    },
  }, 404);
};

export function createErrorHandler(fallbackLogger?: Logger): ErrorHandler<AppBindings> {
  return (err, c) => {
    const requestId = getRequestId(c);
    const log = c.get("logger") ?? fallbackLogger;

    if (err instanceof AppError) {
      if (err.status >= 500) {
        log?.error({ err, requestId, code: err.code }, err.message);
      }
      else {
        log?.warn({ requestId, code: err.code, status: err.status }, err.message);
      }

      return c.json({
        error: {
          code: err.code,
          message: err.status === 500 ? "Internal server error" : err.message,
          requestId,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      }, err.status);
    }

    if (err instanceof HTTPException) {
      const status = err.status as ContentfulStatusCode;
      if (status >= 500) {
        log?.error({ err, requestId, status }, "HTTPException 5xx");
        return c.json({
          error: {
            code: status === 503 ? "SERVICE_UNAVAILABLE" : "INTERNAL_SERVER_ERROR",
            message: status === 503 ? "Service unavailable" : "Internal server error",
            requestId,
          },
        }, status);
      }

      const code = HTTP_EXCEPTION_CODES[status] ?? "BAD_REQUEST";
      const message = err.message || STATUS_DESCRIPTIONS[status] || "Request error";
      log?.warn({ requestId, code, status }, message);
      return c.json({
        error: {
          code,
          message,
          requestId,
        },
      }, status);
    }

    log?.error({ err, requestId }, "Unhandled error");

    return c.json({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
        requestId,
      },
    }, 500);
  };
}
