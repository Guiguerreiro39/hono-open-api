import type { RateLimiterPort } from "@/core/ports/rate-limit";
import { requestId } from "hono/request-id";
import { afterEach, describe, expect, it } from "vitest";

import { createErrorHandler } from "@/core/errors";
import { createRouter } from "@/core/http";

export interface RateLimiterContractHarness {
  rateLimiter: RateLimiterPort;
  cleanup: () => Promise<void>;
  advanceTimeMs: (ms: number) => Promise<void>;
  windowMs: number;
}

export function defineRateLimiterContract(
  suiteName: string,
  createHarness: () => Promise<RateLimiterContractHarness>,
) {
  describe(`RateLimiterPort contract (${suiteName})`, () => {
    const cleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
      while (cleanups.length > 0) {
        await cleanups.pop()?.();
      }
    });

    it("enforces limit per key, isolates tiers, resets keys, and refills after windowMs", async () => {
      const harness = await createHarness();
      cleanups.push(harness.cleanup);
      const { rateLimiter, advanceTimeMs, windowMs } = harness;

      const policyA = { tier: "auth_mutation", limit: 3, windowMs };
      const policyB = { tier: "api", limit: 3, windowMs };

      expect(await rateLimiter.consume(policyA, "ip:1.2.3.4")).toMatchObject({
        allowed: true,
        limit: 3,
        remaining: 2,
      });
      expect(await rateLimiter.consume(policyA, "ip:1.2.3.4")).toMatchObject({
        allowed: true,
        limit: 3,
        remaining: 1,
      });
      expect(await rateLimiter.consume(policyA, "ip:1.2.3.4")).toMatchObject({
        allowed: true,
        limit: 3,
        remaining: 0,
      });

      const blocked = await rateLimiter.consume(policyA, "ip:1.2.3.4");
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);

      // Different key and different tier remain independent
      expect(await rateLimiter.consume(policyA, "ip:5.6.7.8")).toMatchObject({
        allowed: true,
        remaining: 2,
      });
      expect(await rateLimiter.consume(policyB, "ip:1.2.3.4")).toMatchObject({
        allowed: true,
        remaining: 2,
      });

      // resetKey clears a single bucket
      await rateLimiter.resetKey("auth_mutation", "ip:1.2.3.4");
      expect(await rateLimiter.consume(policyA, "ip:1.2.3.4")).toMatchObject({
        allowed: true,
        remaining: 2,
      });

      // Exhaust again and wait for window reset
      await rateLimiter.consume(policyA, "ip:1.2.3.4");
      await rateLimiter.consume(policyA, "ip:1.2.3.4");
      expect((await rateLimiter.consume(policyA, "ip:1.2.3.4")).allowed).toBe(false);

      await advanceTimeMs(windowMs + 50);

      expect(await rateLimiter.consume(policyA, "ip:1.2.3.4")).toMatchObject({
        allowed: true,
        remaining: 2,
      });
    });

    it("emits draft-7 headers and ADR-0002 429 RateLimitError with Retry-After in Hono middleware", async () => {
      const harness = await createHarness();
      cleanups.push(harness.cleanup);
      const { rateLimiter, windowMs } = harness;

      const app = createRouter()
        .use("*", requestId())
        .onError(createErrorHandler());

      app.use(
        "/limited/*",
        rateLimiter.middleware({
          tier: "contract_mw",
          limit: 2,
          windowMs,
          keyGenerator: c => c.req.header("x-test-client") ?? "default-client",
          skip: c => c.req.path === "/limited/exempt",
        }),
      );
      app.get("/limited/ping", c => c.json({ ok: true }, 200));
      app.get("/limited/exempt", c => c.json({ ok: true }, 200));

      const first = await app.request("/limited/ping", {
        headers: { "x-test-client": "client-1" },
      });
      expect(first.status).toBe(200);
      expect(first.headers.get("RateLimit-Policy")).toBe(`2;w=${Math.ceil(windowMs / 1000)}`);
      expect(first.headers.get("RateLimit")).toMatch(/^limit=2, remaining=1, reset=\d+$/);

      const second = await app.request("/limited/ping", {
        headers: { "x-test-client": "client-1" },
      });
      expect(second.status).toBe(200);
      expect(second.headers.get("RateLimit")).toMatch(/^limit=2, remaining=0, reset=\d+$/);

      const third = await app.request("/limited/ping", {
        headers: {
          "x-test-client": "client-1",
          "X-Request-Id": "req-rate-limited",
        },
      });
      expect(third.status).toBe(429);
      expect(third.headers.get("RateLimit-Policy")).toBe(`2;w=${Math.ceil(windowMs / 1000)}`);
      expect(third.headers.get("RateLimit")).toMatch(/^limit=2, remaining=0, reset=\d+$/);
      expect(Number(third.headers.get("Retry-After"))).toBeGreaterThanOrEqual(0);
      expect(await third.json()).toEqual({
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: "Too many requests",
          requestId: "req-rate-limited",
        },
      });

      // Exempt route bypasses rate limiter and sets no RateLimit headers
      const exempt = await app.request("/limited/exempt", {
        headers: { "x-test-client": "client-1" },
      });
      expect(exempt.status).toBe(200);
      expect(exempt.headers.get("RateLimit")).toBeNull();
    });
  });
}
