import { execSync } from "node:child_process";
import fs from "node:fs";
import { testClient } from "hono/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ZodIssueCode } from "zod";

import env from "@/env";
import { auth } from "@/lib/auth";
import { ZOD_ERROR_CODES, ZOD_ERROR_MESSAGES } from "@/lib/constants";
import { createTestApp } from "@/lib/create-app";

import router from "./tasks.index";

if (env.NODE_ENV !== "test") {
  throw new Error("NODE_ENV must be 'test'");
}

const client = testClient<typeof router>(createTestApp(router));

describe("tasks routes with auth", () => {
  let user1AuthHeader: { authorization: string };
  let user2AuthHeader: { authorization: string };

  beforeAll(async () => {
    execSync("pnpm drizzle-kit push");

    const res1 = await auth.api.signUpEmail({
      body: {
        email: "user1@example.com",
        password: "password123",
        name: "User One",
      },
    });
    user1AuthHeader = { authorization: `Bearer ${res1.token}` };

    const res2 = await auth.api.signUpEmail({
      body: {
        email: "user2@example.com",
        password: "password123",
        name: "User Two",
      },
    });
    user2AuthHeader = { authorization: `Bearer ${res2.token}` };
  });

  afterAll(async () => {
    fs.rmSync("test.db", { force: true });
  });

  it("unauthenticated requests return 401", async () => {
    const resGet = await client.tasks.$get();
    expect(resGet.status).toBe(401);

    const resPost = await client.tasks.$post({ json: { name: "test", done: false } });
    expect(resPost.status).toBe(401);
  });

  it("post /tasks validates the body when creating", async () => {
    const response = await client.tasks.$post({
      json: {
        done: false,
      } as any,
    }, {
      headers: user1AuthHeader,
    });
    expect(response.status).toBe(422);
    if (response.status === 422) {
      const json = await response.json();
      expect(json.error.issues[0].path[0]).toBe("name");
      expect(json.error.issues[0].message).toBe(ZOD_ERROR_MESSAGES.EXPECTED_STRING);
    }
  });

  let task1Id: number;
  const name1 = "Learn vitest";

  it("post /tasks creates a task for authenticated user", async () => {
    const response = await client.tasks.$post({
      json: {
        name: name1,
        done: false,
      },
    }, {
      headers: user1AuthHeader,
    });
    expect(response.status).toBe(200);
    if (response.status === 200) {
      const json = await response.json();
      expect(json.name).toBe(name1);
      expect(json.done).toBe(false);
      task1Id = json.id;
    }
  });

  it("get /tasks lists only user's own tasks", async () => {
    // User 1 sees 1 task
    const response1 = await client.tasks.$get(undefined, {
      headers: user1AuthHeader,
    });
    expect(response1.status).toBe(200);
    if (response1.status === 200) {
      const json = await response1.json();
      expect(Array.isArray(json)).toBe(true);
      expect(json.length).toBe(1);
      expect(json[0].id).toBe(task1Id);
    }

    // User 2 sees 0 tasks
    const response2 = await client.tasks.$get(undefined, {
      headers: user2AuthHeader,
    });
    expect(response2.status).toBe(200);
    if (response2.status === 200) {
      const json = await response2.json();
      expect(Array.isArray(json)).toBe(true);
      expect(json.length).toBe(0);
    }
  });

  it("get /tasks/{id} validates the id param", async () => {
    const response = await client.tasks[":id"].$get({
      param: {
        id: "wat",
      },
    }, {
      headers: user1AuthHeader,
    });
    expect(response.status).toBe(422);
    if (response.status === 422) {
      const json = await response.json();
      expect(json.error.issues[0].path[0]).toBe("id");
      expect(json.error.issues[0].message).toBe(ZOD_ERROR_MESSAGES.EXPECTED_NUMBER);
    }
  });

  it("get /tasks/{id} returns 404 when task not found or belongs to another user", async () => {
    // Non-existent task
    const response404 = await client.tasks[":id"].$get({
      param: {
        id: 999,
      },
    }, {
      headers: user1AuthHeader,
    });
    expect(response404.status).toBe(404);

    // User 2 trying to access User 1's task
    const responseForbidden = await client.tasks[":id"].$get({
      param: {
        id: task1Id,
      },
    }, {
      headers: user2AuthHeader,
    });
    expect(responseForbidden.status).toBe(404);
  });

  it("get /tasks/{id} gets a single task for owner", async () => {
    const response = await client.tasks[":id"].$get({
      param: {
        id: task1Id,
      },
    }, {
      headers: user1AuthHeader,
    });
    expect(response.status).toBe(200);
    if (response.status === 200) {
      const json = await response.json();
      expect(json.name).toBe(name1);
      expect(json.done).toBe(false);
    }
  });

  it("patch /tasks/{id} validates the body when updating", async () => {
    const response = await client.tasks[":id"].$patch({
      param: {
        id: task1Id,
      },
      json: {
        name: "",
      },
    }, {
      headers: user1AuthHeader,
    });
    expect(response.status).toBe(422);
    if (response.status === 422) {
      const json = await response.json();
      expect(json.error.issues[0].path[0]).toBe("name");
      expect(json.error.issues[0].code).toBe(ZodIssueCode.too_small);
    }
  });

  it("patch /tasks/{id} validates empty body", async () => {
    const response = await client.tasks[":id"].$patch({
      param: {
        id: task1Id,
      },
      json: {},
    }, {
      headers: user1AuthHeader,
    });
    expect(response.status).toBe(422);
    if (response.status === 422) {
      const json = await response.json();
      expect(json.error.issues[0].code).toBe(ZOD_ERROR_CODES.INVALID_UPDATES);
      expect(json.error.issues[0].message).toBe(ZOD_ERROR_MESSAGES.NO_UPDATES);
    }
  });

  it("patch /tasks/{id} prevents updating another user's task", async () => {
    const response = await client.tasks[":id"].$patch({
      param: {
        id: task1Id,
      },
      json: {
        done: true,
      },
    }, {
      headers: user2AuthHeader,
    });
    expect(response.status).toBe(404);
  });

  it("patch /tasks/{id} updates task for owner", async () => {
    const response = await client.tasks[":id"].$patch({
      param: {
        id: task1Id,
      },
      json: {
        done: true,
      },
    }, {
      headers: user1AuthHeader,
    });
    expect(response.status).toBe(200);
    if (response.status === 200) {
      const json = await response.json();
      expect(json.done).toBe(true);
    }
  });

  it("delete /tasks/{id} prevents deleting another user's task", async () => {
    const response = await client.tasks[":id"].$delete({
      param: {
        id: task1Id,
      },
    }, {
      headers: user2AuthHeader,
    });
    expect(response.status).toBe(404);
  });

  it("delete /tasks/{id} removes task for owner", async () => {
    const response = await client.tasks[":id"].$delete({
      param: {
        id: task1Id,
      },
    }, {
      headers: user1AuthHeader,
    });
    expect(response.status).toBe(204);
  });
});
