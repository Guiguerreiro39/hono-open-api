import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { createLogger } from "@/core/logger";
import { parseEnv } from "@/env";
import { buildPubSubChannel, RedisPubSubAdapter } from "@/infra/realtime";
import { createRedisClient } from "@/infra/redis";
import { definePubSubContract } from "../contracts/pubsub.contract";
import { createSseReader } from "../helpers/sse";
import { createTestApp } from "../helpers/test-app";
import { getIntegrationEnv } from "./env";

const integrationEnv = getIntegrationEnv();
const REDIS_URL = integrationEnv.REDIS_URL;

async function assertRedisReachable(): Promise<void> {
  const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", REDIS_URL });
  const handle = createRedisClient({
    url: REDIS_URL,
    logger: createLogger(env),
    connectionName: "pubsub-integration-preflight",
    connectTimeoutMs: 2000,
  });

  try {
    await handle.ping();
  }
  catch (err) {
    throw new Error(
      `PubSub integration test requires a reachable Redis server at ${REDIS_URL}. Start it with "docker compose up -d --wait redis".`,
      { cause: err },
    );
  }
  finally {
    await handle.quit();
  }
}

beforeAll(async () => {
  await assertRedisReachable();
});

definePubSubContract("RedisPubSubAdapter", async () => {
  const prefix = `int-pubsub-${crypto.randomUUID().slice(0, 8)}`;
  const env = parseEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    REDIS_URL,
    CACHE_PREFIX: prefix,
  });
  const logger = createLogger(env);
  const handle = createRedisClient({
    url: REDIS_URL,
    logger,
    connectionName: prefix,
  });
  await handle.ping();

  const pubsub = new RedisPubSubAdapter({
    pub: handle.client,
    ping: handle.ping,
    prefix,
    logger,
  });

  return {
    pubsub,
    waitForDelivery: () => new Promise(resolve => setTimeout(resolve, 25)),
    cleanup: async () => {
      await pubsub.close();
      await handle.quit();
    },
  };
});

describe("redisPubSubAdapter ref-counting, fan-out, and /api/v1/tasks/live integration", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("ref-counts 0<->1 Redis SUBSCRIBE/UNSUBSCRIBE and fans out across independent adapter instances", async () => {
    const prefix = `int-fanout-${crypto.randomUUID().slice(0, 8)}`;
    const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", REDIS_URL, CACHE_PREFIX: prefix });
    const logger = createLogger(env);

    const handleA = createRedisClient({ url: REDIS_URL, logger, connectionName: `${prefix}-a` });
    const handleB = createRedisClient({ url: REDIS_URL, logger, connectionName: `${prefix}-b` });
    await Promise.all([handleA.ping(), handleB.ping()]);

    const pubsubA = new RedisPubSubAdapter({ pub: handleA.client, ping: handleA.ping, prefix, logger });
    const pubsubB = new RedisPubSubAdapter({ pub: handleB.client, ping: handleB.ping, prefix, logger });

    cleanups.push(async () => {
      await pubsubA.close();
      await pubsubB.close();
      await handleA.quit();
      await handleB.quit();
    });

    const receivedA1: unknown[] = [];
    const receivedA2: unknown[] = [];
    const receivedB: unknown[] = [];

    const unsubA1 = await pubsubA.subscribe("tasks:shared", evt => void receivedA1.push(evt));
    const unsubA2 = await pubsubA.subscribe("tasks:shared", evt => void receivedA2.push(evt));
    const unsubB = await pubsubB.subscribe("tasks:shared", evt => void receivedB.push(evt));

    const channel = buildPubSubChannel(prefix, "tasks:shared");
    const numsubActive = await handleA.client.call("PUBSUB", "NUMSUB", channel) as [string, number];
    // One Redis subscription per adapter instance (2 total), despite 2 local listeners on pubsubA
    expect(Number(numsubActive[1])).toBe(2);

    await pubsubA.publish("tasks:shared", { action: "create", data: { id: "x1" } });
    await new Promise(resolve => setTimeout(resolve, 40));

    expect(receivedA1).toHaveLength(1);
    expect(receivedA2).toHaveLength(1);
    expect(receivedB).toHaveLength(1);

    await unsubA1();
    const numsubAfterOne = await handleA.client.call("PUBSUB", "NUMSUB", channel) as [string, number];
    expect(Number(numsubAfterOne[1])).toBe(2);

    await unsubA2();
    await unsubB();
    const numsubAfterAll = await handleA.client.call("PUBSUB", "NUMSUB", channel) as [string, number];
    expect(Number(numsubAfterAll[1])).toBe(0);
  });

  it("streams live task updates end-to-end over RedisPubSubAdapter on GET /api/v1/tasks/live", async () => {
    const prefix = `int-sse-${crypto.randomUUID().slice(0, 8)}`;
    const ctx = await createTestApp({
      REDIS_URL,
      CACHE_PREFIX: prefix,
    });
    cleanups.push(ctx.cleanup);

    const user = await ctx.seedUser({ email: "redis-sse@example.com" });
    const liveRes = await ctx.client.api.v1.tasks.live.$get({
      query: {},
    }, { headers: user.headers });
    expect(liveRes.status).toBe(200);

    const sse = createSseReader(liveRes);
    cleanups.push(() => sse.close());

    const initEvt = await sse.next();
    expect(initEvt?.event).toBe("init");
    expect(JSON.parse(initEvt!.data)).toMatchObject({ data: [] });

    const created = await ctx.client.api.v1.tasks.$post({
      json: { name: "Redis live task" },
    }, { headers: user.headers });
    expect(created.status).toBe(201);

    const updateEvt = await sse.next();
    expect(updateEvt?.event).toBe("update");
    expect(JSON.parse(updateEvt!.data).data[0].name).toBe("Redis live task");
  });
});
