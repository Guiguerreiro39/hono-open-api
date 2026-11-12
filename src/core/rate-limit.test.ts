import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
  isAuthMutationRequest,
  isExemptRateLimitPath,
  resolveClientIp,
} from "@/core/rate-limit";

describe("core rate-limit helpers", () => {
  it("classifies exempt paths and auth mutation routes accurately", () => {
    expect(isExemptRateLimitPath("/health")).toBe(true);
    expect(isExemptRateLimitPath("/health/")).toBe(true);
    expect(isExemptRateLimitPath("/ready")).toBe(true);
    expect(isExemptRateLimitPath("/metrics")).toBe(true);
    expect(isExemptRateLimitPath("/doc")).toBe(true);
    expect(isExemptRateLimitPath("/reference")).toBe(true);
    expect(isExemptRateLimitPath("/api/auth/open-api/generate-schema")).toBe(true);
    expect(isExemptRateLimitPath("/api/v1/me")).toBe(false);

    expect(isAuthMutationRequest("POST", "/api/auth/sign-in/email")).toBe(true);
    expect(isAuthMutationRequest("POST", "/api/auth/sign-up/email")).toBe(true);
    expect(isAuthMutationRequest("POST", "/api/auth/request-password-reset")).toBe(true);
    expect(isAuthMutationRequest("POST", "/api/auth/reset-password")).toBe(true);
    expect(isAuthMutationRequest("POST", "/api/auth/forget-password")).toBe(true);
    expect(isAuthMutationRequest("POST", "/api/auth/forget-password/email-otp")).toBe(true);
    expect(isAuthMutationRequest("POST", "/api/auth/change-password")).toBe(true);

    expect(isAuthMutationRequest("GET", "/api/auth/sign-in/email")).toBe(false);
    expect(isAuthMutationRequest("GET", "/api/auth/get-session")).toBe(false);
    expect(isAuthMutationRequest("POST", "/api/auth/sign-out")).toBe(false);
  });

  it("extracts client IP from Node conninfo and honors TRUST_PROXY strictly", async () => {
    const app = new Hono();
    app.get("/ip", (c) => {
      const trustProxy = c.req.query("trust") === "true";
      return c.json({ ip: resolveClientIp(c, trustProxy) });
    });

    const nodeBindings = {
      incoming: {
        socket: {
          remoteAddress: "10.20.30.40",
          remotePort: 54321,
          remoteFamily: "IPv4",
        },
      },
    };

    const untrustedRes = await app.request(
      "/ip?trust=false",
      {
        headers: {
          "x-forwarded-for": "198.51.100.99",
          "x-real-ip": "198.51.100.88",
        },
      },
      nodeBindings,
    );
    expect(await untrustedRes.json()).toEqual({ ip: "10.20.30.40" });

    const forwardedRes = await app.request(
      "/ip?trust=true",
      {
        headers: {
          "x-forwarded-for": " 198.51.100.99 , 10.0.0.1 ",
          "x-real-ip": "198.51.100.88",
        },
      },
      nodeBindings,
    );
    expect(await forwardedRes.json()).toEqual({ ip: "198.51.100.99" });

    const realIpRes = await app.request(
      "/ip?trust=true",
      {
        headers: {
          "x-forwarded-for": " , ",
          "x-real-ip": "198.51.100.88",
        },
      },
      nodeBindings,
    );
    expect(await realIpRes.json()).toEqual({ ip: "198.51.100.88" });

    const fallbackSocketRes = await app.request("/ip?trust=true", undefined, nodeBindings);
    expect(await fallbackSocketRes.json()).toEqual({ ip: "10.20.30.40" });

    const noSocketRes = await app.request("/ip?trust=false");
    expect(await noSocketRes.json()).toEqual({ ip: "unknown" });
  });
});
