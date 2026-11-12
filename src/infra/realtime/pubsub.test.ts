import type { RedisPubSubClient } from "@/infra/realtime";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import { createLogger } from "@/core/logger";
import { parseEnv } from "@/env";
import { MemoryPubSubAdapter, RedisPubSubAdapter } from "@/infra/realtime";
import { definePubSubContract } from "../../../tests/contracts/pubsub.contract";

class FakeRedisPubSubBus {
  readonly channels = new Map<string, Set<FakeRedisClient>>();
  readonly subscribeCalls: string[] = [];
  readonly unsubscribeCalls: string[] = [];
  shouldFailPublish = false;
}

class FakeRedisClient extends EventEmitter implements RedisPubSubClient {
  status = "ready";
  options?: { connectionName?: string; maxRetriesPerRequest?: number | null };
  duplicated: FakeRedisClient[] = [];
  quitCalls = 0;

  constructor(
    private readonly bus: FakeRedisPubSubBus,
    options?: { connectionName?: string; maxRetriesPerRequest?: number | null },
  ) {
    super();
    this.options = options;
  }

  duplicate(override?: { connectionName?: string; maxRetriesPerRequest?: number | null }): RedisPubSubClient {
    const child = new FakeRedisClient(this.bus, {
      ...this.options,
      ...override,
    });
    this.duplicated.push(child);
    return child;
  }

  async publish(channel: string, message: string): Promise<number> {
    if (this.bus.shouldFailPublish) {
      throw new Error("Redis publish failed");
    }
    const subscribers = this.bus.channels.get(channel);
    if (!subscribers) {
      return 0;
    }
    for (const sub of subscribers) {
      sub.emit("message", channel, message);
    }
    return subscribers.size;
  }

  async subscribe(...channels: string[]): Promise<number> {
    for (const ch of channels) {
      this.bus.subscribeCalls.push(ch);
      let set = this.bus.channels.get(ch);
      if (!set) {
        set = new Set();
        this.bus.channels.set(ch, set);
      }
      set.add(this);
    }
    return this.bus.channels.size;
  }

  async unsubscribe(...channels: string[]): Promise<number> {
    for (const ch of channels) {
      this.bus.unsubscribeCalls.push(ch);
      this.bus.channels.get(ch)?.delete(this);
    }
    return this.bus.channels.size;
  }

  async ping(): Promise<string> {
    return "PONG";
  }

  async connect(): Promise<void> {
    this.status = "ready";
    this.emit("ready");
  }

  async quit(): Promise<string> {
    this.quitCalls++;
    this.status = "end";
    return "OK";
  }

  disconnect(): void {
    this.status = "end";
  }
}

definePubSubContract("MemoryPubSubAdapter", async () => {
  const pubsub = new MemoryPubSubAdapter();
  return {
    pubsub,
    cleanup: async () => {
      await pubsub.close();
    },
  };
});

definePubSubContract("RedisPubSubAdapter (FakeRedis boundary)", async () => {
  const bus = new FakeRedisPubSubBus();
  const pub = new FakeRedisClient(bus, { connectionName: "test" });
  const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "silent" });
  const pubsub = new RedisPubSubAdapter({
    pub,
    prefix: "test",
    logger: createLogger(env),
  });
  return {
    pubsub,
    cleanup: async () => {
      await pubsub.close();
    },
  };
});

describe("memoryPubSubAdapter", () => {
  const adapters: MemoryPubSubAdapter[] = [];

  afterEach(async () => {
    while (adapters.length > 0) {
      await adapters.pop()?.close();
    }
  });

  it("supports >10 concurrent subscribers without MaxListeners warnings, tracks listenerCount(topic), and clear() removes all", async () => {
    const pubsub = new MemoryPubSubAdapter();
    adapters.push(pubsub);

    const warnings: Error[] = [];
    const onWarning = (warning: Error) => {
      warnings.push(warning);
    };
    process.on("warning", onWarning);

    try {
      const counts: number[] = [];
      const unsubs: Array<() => Promise<void>> = [];
      for (let i = 0; i < 15; i++) {
        unsubs.push(await pubsub.subscribe("tasks:hot", () => {
          counts.push(i);
        }));
      }

      expect(pubsub.listenerCount("tasks:hot")).toBe(15);
      await pubsub.publish("tasks:hot", { action: "update", data: { ok: true } });
      expect(counts).toHaveLength(15);
      expect(warnings.filter(w => w.name === "MaxListenersExceededWarning")).toEqual([]);

      await unsubs[0]();
      expect(pubsub.listenerCount("tasks:hot")).toBe(14);

      pubsub.clear();
      expect(pubsub.listenerCount("tasks:hot")).toBe(0);
    }
    finally {
      process.off("warning", onWarning);
    }
  });
});

describe("redisPubSubAdapter", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("duplicates pub for sub, attaches error listeners on both, ref-counts 0<->1 SUBSCRIBE/UNSUBSCRIBE with prefix, and fails open on publish errors", async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, cb) {
        lines.push(chunk.toString("utf8"));
        cb();
      },
    });
    const env = parseEnv({ NODE_ENV: "test", LOG_LEVEL: "warn" });
    const logger = createLogger(env, sink);
    const bus = new FakeRedisPubSubBus();
    const pub = new FakeRedisClient(bus, { connectionName: "api" });

    const pubsub = new RedisPubSubAdapter({
      pub,
      prefix: "myapp",
      logger,
    });
    cleanups.push(() => pubsub.close());

    expect(pub.duplicated).toHaveLength(1);
    const sub = pub.duplicated[0];
    expect(sub.options?.connectionName).toBe("api:pubsub");
    expect(pub.listenerCount("error")).toBeGreaterThanOrEqual(1);
    expect(sub.listenerCount("error")).toBeGreaterThanOrEqual(1);

    // Emitting error on either pub or sub logs warn without crashing
    pub.emit("error", new Error("pub socket blip"));
    sub.emit("error", new Error("sub socket blip"));

    // Concurrent subscribes on same topic issue only ONE Redis SUBSCRIBE
    const received1: unknown[] = [];
    const received2: unknown[] = [];
    const [unsub1, unsub2] = await Promise.all([
      pubsub.subscribe("tasks:u1", evt => void received1.push(evt)),
      pubsub.subscribe("tasks:u1", evt => void received2.push(evt)),
    ]);

    expect(bus.subscribeCalls).toEqual(["myapp:pubsub:tasks:u1"]);
    expect(pubsub.listenerCount("tasks:u1")).toBe(2);

    await pubsub.publish("tasks:u1", { action: "create", data: { id: "1" } });
    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);

    // First unsubscribe keeps Redis subscription active
    await unsub1();
    expect(bus.unsubscribeCalls).toEqual([]);
    expect(pubsub.listenerCount("tasks:u1")).toBe(1);

    // Second unsubscribe drops refcount 1 -> 0 and issues UNSUBSCRIBE
    await unsub2();
    expect(bus.unsubscribeCalls).toEqual(["myapp:pubsub:tasks:u1"]);
    expect(pubsub.listenerCount("tasks:u1")).toBe(0);

    // Fail-open publish logs warn and resolves cleanly
    bus.shouldFailPublish = true;
    await expect(pubsub.publish("tasks:u1", { action: "delete", data: { id: "1" } })).resolves.toBeUndefined();

    await pubsub.close();
    expect(sub.quitCalls).toBe(1);

    const logEntries = lines
      .join("")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line) as { level: number; msg: string });
    expect(logEntries.some(entry => entry.msg.includes("pub") || entry.msg.includes("error"))).toBe(true);
    expect(logEntries.some(entry => entry.msg.toLowerCase().includes("publish"))).toBe(true);
  });
});
