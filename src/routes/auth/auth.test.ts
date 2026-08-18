import { execSync } from "node:child_process";
import fs from "node:fs";
import { testClient } from "hono/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import env from "@/env";
import { createTestApp } from "@/lib/create-app";
import router from "./auth.index";

if (env.NODE_ENV !== "test") {
  throw new Error("NODE_ENV must be 'test'");
}

const client: any = testClient(createTestApp(router));

describe("auth openapi routes", () => {
  beforeAll(async () => {
    execSync("pnpm drizzle-kit push");
  });

  afterAll(async () => {
    fs.rmSync("test.db", { force: true });
  });

  it("POST /api/auth/sign-up/email registers a user", async () => {
    const res = await client.api.auth["sign-up"].email.$post({
      json: {
        email: "test-auth@example.com",
        password: "password123",
        name: "Test Auth User",
      },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.email).toBe("test-auth@example.com");
  });

  it("POST /api/auth/sign-in/email logs in a user", async () => {
    const res = await client.api.auth["sign-in"].email.$post({
      json: {
        email: "test-auth@example.com",
        password: "password123",
      },
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.user.email).toBe("test-auth@example.com");
  });
});
