import { execSync } from "node:child_process";
import fs from "node:fs";
import { testClient } from "hono/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import env from "@/env";
import { auth } from "@/lib/auth";
import { createTestApp } from "@/lib/create-app";

import router from "./users.index";

if (env.NODE_ENV !== "test") {
  throw new Error("NODE_ENV must be 'test'");
}

const client = testClient<typeof router>(createTestApp(router));

describe("users routes with auth", () => {
  let authHeader: { authorization: string };

  beforeAll(async () => {
    execSync("pnpm drizzle-kit push");

    const res = await auth.api.signUpEmail({
      body: {
        email: "admin@example.com",
        password: "password123",
        name: "Admin User",
      },
    });
    authHeader = { authorization: `Bearer ${res.token}` };
  });

  afterAll(async () => {
    fs.rmSync("test.db", { force: true });
  });

  it("unauthenticated GET /users returns 401", async () => {
    const resGet = await client.users.$get();
    expect(resGet.status).toBe(401);
  });

  it("unauthenticated POST /users returns 401", async () => {
    const resPost = await client.users.$post({
      json: {
        name: "Unauthenticated User",
        email: "unauth@example.com",
        emailVerified: false,
      },
    });
    expect(resPost.status).toBe(401);
  });

  it("post /users validates request body", async () => {
    const response = await client.users.$post({
      json: {
        name: "Invalid Email",
        email: "not-an-email",
        emailVerified: false,
      },
    }, {
      headers: authHeader,
    });
    expect(response.status).toBe(422);
  });

  let createdUserId: string;

  it("post /users creates a new user when authenticated", async () => {
    const response = await client.users.$post({
      json: {
        name: "New User",
        email: "newuser@example.com",
        emailVerified: true,
      },
    }, {
      headers: authHeader,
    });

    expect(response.status).toBe(200);
    if (response.status === 200) {
      const json = await response.json();
      expect(json.name).toBe("New User");
      expect(json.email).toBe("newuser@example.com");
      expect(json.emailVerified).toBe(true);
      expect(json.id).toBeDefined();
      createdUserId = json.id;
    }
  });

  it("post /users returns 409 for duplicate email", async () => {
    const response = await client.users.$post({
      json: {
        name: "Duplicate User",
        email: "newuser@example.com",
        emailVerified: true,
      },
    }, {
      headers: authHeader,
    });
    expect(response.status).toBe(409);
  });

  it("get /users lists all users", async () => {
    const response = await client.users.$get(undefined, {
      headers: authHeader,
    });

    expect(response.status).toBe(200);
    if (response.status === 200) {
      const json = await response.json();
      expect(Array.isArray(json)).toBe(true);
      expect(json.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("get /users/{id} returns 404 for non-existent user", async () => {
    const response = await client.users[":id"].$get({
      param: {
        id: "non-existent-id",
      },
    }, {
      headers: authHeader,
    });

    expect(response.status).toBe(404);
  });

  it("get /users/{id} fetches a user by id", async () => {
    const response = await client.users[":id"].$get({
      param: {
        id: createdUserId,
      },
    }, {
      headers: authHeader,
    });

    expect(response.status).toBe(200);
    if (response.status === 200) {
      const json = await response.json();
      expect(json.id).toBe(createdUserId);
      expect(json.name).toBe("New User");
    }
  });

  it("patch /users/{id} validates empty body", async () => {
    const response = await client.users[":id"].$patch({
      param: {
        id: createdUserId,
      },
      json: {},
    }, {
      headers: authHeader,
    });

    expect(response.status).toBe(422);
  });

  it("patch /users/{id} updates user details", async () => {
    const response = await client.users[":id"].$patch({
      param: {
        id: createdUserId,
      },
      json: {
        name: "Updated User Name",
      },
    }, {
      headers: authHeader,
    });

    expect(response.status).toBe(200);
    if (response.status === 200) {
      const json = await response.json();
      expect(json.name).toBe("Updated User Name");
    }
  });

  it("patch /users/{id} returns 404 for non-existent user", async () => {
    const response = await client.users[":id"].$patch({
      param: {
        id: "non-existent-id",
      },
      json: {
        name: "Ghost User",
      },
    }, {
      headers: authHeader,
    });

    expect(response.status).toBe(404);
  });

  it("delete /users/{id} deletes user", async () => {
    const response = await client.users[":id"].$delete({
      param: {
        id: createdUserId,
      },
    }, {
      headers: authHeader,
    });

    expect(response.status).toBe(204);
  });

  it("delete /users/{id} returns 404 for non-existent user", async () => {
    const response = await client.users[":id"].$delete({
      param: {
        id: createdUserId,
      },
    }, {
      headers: authHeader,
    });

    expect(response.status).toBe(404);
  });
});
