import type { AppError } from "@/core/errors";
import { $, createRoute, z } from "@hono/zod-openapi";
import { requestId } from "hono/request-id";
import { describe, expect, it } from "vitest";

import {
  BadRequestError,
  ConflictError,
  createErrorHandler,
  createErrorResponses,
  ForbiddenError,
  NotFoundError,
  notFoundHandler,
  PayloadTooLargeError,
  RateLimitError,
  RequestTimeoutError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
} from "@/core/errors";
import { createRouter } from "@/core/http";

describe("core HTTP error envelope", () => {
  it("serializes every AppError subclass into the canonical error envelope", async () => {
    const cases: Array<{ err: AppError; expectedStatus: number; expectedCode: string }> = [
      { err: new BadRequestError("bad input"), expectedStatus: 400, expectedCode: "BAD_REQUEST" },
      { err: new UnauthorizedError("auth required"), expectedStatus: 401, expectedCode: "UNAUTHORIZED" },
      { err: new ForbiddenError("forbidden"), expectedStatus: 403, expectedCode: "FORBIDDEN" },
      { err: new NotFoundError("missing"), expectedStatus: 404, expectedCode: "NOT_FOUND" },
      { err: new RequestTimeoutError("timed out"), expectedStatus: 408, expectedCode: "REQUEST_TIMEOUT" },
      { err: new ConflictError("already exists"), expectedStatus: 409, expectedCode: "CONFLICT" },
      { err: new PayloadTooLargeError("too large"), expectedStatus: 413, expectedCode: "PAYLOAD_TOO_LARGE" },
      { err: new ValidationError("invalid", { details: [{ path: ["name"] }] }), expectedStatus: 422, expectedCode: "VALIDATION_ERROR" },
      { err: new RateLimitError("slow down"), expectedStatus: 429, expectedCode: "RATE_LIMIT_EXCEEDED" },
      { err: new ServiceUnavailableError("unavailable"), expectedStatus: 503, expectedCode: "SERVICE_UNAVAILABLE" },
    ];

    for (const [index, testCase] of cases.entries()) {
      const app = createRouter()
        .use("*", requestId())
        .onError(createErrorHandler())
        .get(`/err/${index}`, () => {
          throw testCase.err;
        });

      const res = await app.request(`/err/${index}`, {
        headers: { "X-Request-Id": `req-${index}` },
      });

      expect(res.status).toBe(testCase.expectedStatus);
      const body = await res.json();
      expect(body).toEqual({
        error: {
          code: testCase.expectedCode,
          message: testCase.err.message,
          requestId: `req-${index}`,
          ...(testCase.err.details !== undefined ? { details: testCase.err.details } : {}),
        },
      });
    }
  });

  it("emits canonical 404 on unmatched routes and 422 on OpenAPI validation failures", async () => {
    const route = createRoute({
      method: "post",
      path: "/items",
      request: {
        body: {
          content: {
            "application/json": {
              schema: z.object({ name: z.string().min(1) }),
            },
          },
        },
      },
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: z.object({ ok: z.boolean() }),
            },
          },
        },
        ...createErrorResponses(400, 422),
      },
    });

    const app = $(
      createRouter()
        .use("*", requestId()),
    )
      .notFound(notFoundHandler)
      .onError(createErrorHandler())
      .openapi(route, c => c.json({ ok: true }, 200));

    const notFoundRes = await app.request("/missing-path", {
      headers: { "X-Request-Id": "req-404" },
    });
    expect(notFoundRes.status).toBe(404);
    expect(await notFoundRes.json()).toEqual({
      error: {
        code: "NOT_FOUND",
        message: "Not found",
        requestId: "req-404",
      },
    });

    const validationRes = await app.request("/items", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "req-422",
      },
      body: JSON.stringify({ name: "" }),
    });
    expect(validationRes.status).toBe(422);
    const validationBody = await validationRes.json();
    expect(validationBody.error.code).toBe("VALIDATION_ERROR");
    expect(validationBody.error.message).toBe("Validation failed");
    expect(validationBody.error.requestId).toBe("req-422");
    expect(Array.isArray(validationBody.error.details)).toBe(true);
    expect(validationBody.error.details.length).toBeGreaterThan(0);

    const malformedJsonRes = await app.request("/items", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Request-Id": "req-bad-json",
      },
      body: "{bad json",
    });
    expect(malformedJsonRes.status).toBe(400);
    expect(await malformedJsonRes.json()).toMatchObject({
      error: {
        code: "BAD_REQUEST",
        requestId: "req-bad-json",
      },
    });
  });

  it("omits internal error details and stack traces on unexpected 500 errors", async () => {
    const app = createRouter()
      .use("*", requestId())
      .onError(createErrorHandler())
      .get("/boom", () => {
        throw new Error("secret postgres connection string leaked");
      });

    const res = await app.request("/boom", {
      headers: { "X-Request-Id": "req-500" },
    });

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain("secret postgres connection string leaked");
    expect(text).not.toContain("at ");
    expect(JSON.parse(text)).toEqual({
      error: {
        code: "INTERNAL_SERVER_ERROR",
        message: "Internal server error",
        requestId: "req-500",
      },
    });
  });
});
