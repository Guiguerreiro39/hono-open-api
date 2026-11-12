import type { PubSubPort, RealtimeEvent } from "@/core/ports/pubsub";
import { afterEach, describe, expect, it } from "vitest";

export interface PubSubContractHarness {
  pubsub: PubSubPort;
  cleanup: () => Promise<void>;
  waitForDelivery?: () => Promise<void>;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for pubsub delivery`);
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export function definePubSubContract(
  suiteName: string,
  createHarness: () => Promise<PubSubContractHarness>,
) {
  describe(`PubSubPort contract (${suiteName})`, () => {
    const cleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
      while (cleanups.length > 0) {
        await cleanups.pop()?.();
      }
    });

    it("delivers published events to topic subscribers and isolates distinct topics", async () => {
      const harness = await createHarness();
      cleanups.push(harness.cleanup);
      const { pubsub } = harness;

      const eventsA: RealtimeEvent<{ id: string }>[] = [];
      const eventsB: RealtimeEvent<{ id: string }>[] = [];

      const unsubA = await pubsub.subscribe<{ id: string }>("tasks:user-a", (event) => {
        eventsA.push(event);
      });
      const unsubB = await pubsub.subscribe<{ id: string }>("tasks:user-b", (event) => {
        eventsB.push(event);
      });

      await pubsub.publish("tasks:user-a", { action: "create", data: { id: "t-1" } });
      await pubsub.publish("tasks:user-b", { action: "update", data: { id: "t-2" } });
      await pubsub.publish("tasks:unsubscribed", { action: "delete", data: { id: "t-3" } });

      await waitUntil(() => eventsA.length === 1 && eventsB.length === 1);

      expect(eventsA).toHaveLength(1);
      expect(eventsA[0]).toMatchObject({ action: "create", data: { id: "t-1" } });
      expect(typeof eventsA[0].timestamp).toBe("number");

      expect(eventsB).toHaveLength(1);
      expect(eventsB[0]).toMatchObject({ action: "update", data: { id: "t-2" } });

      await unsubA();
      await unsubB();
    });

    it("supports multiple subscribers on one topic, idempotent unsubscribe, and stops delivery after unsubscribe", async () => {
      const harness = await createHarness();
      cleanups.push(harness.cleanup);
      const { pubsub } = harness;

      const received1: string[] = [];
      const received2: string[] = [];

      const unsub1 = await pubsub.subscribe<{ seq: number }>("tasks:all", (event) => {
        received1.push(`${event.action}:${event.data?.seq}`);
      });
      const unsub2 = await pubsub.subscribe<{ seq: number }>("tasks:all", (event) => {
        received2.push(`${event.action}:${event.data?.seq}`);
      });

      await pubsub.publish("tasks:all", { action: "create", data: { seq: 1 } });
      await waitUntil(() => received1.length === 1 && received2.length === 1);

      // Unsubscribe first listener (idempotent second call)
      await unsub1();
      await unsub1();

      await pubsub.publish("tasks:all", { action: "update", data: { seq: 2 } });
      await waitUntil(() => received2.length === 2);
      if (harness.waitForDelivery) {
        await harness.waitForDelivery();
      }

      expect(received1).toEqual(["create:1"]);
      expect(received2).toEqual(["create:1", "update:2"]);

      // Unsubscribe second listener; subsequent publishes must not deliver
      await unsub2();
      await pubsub.publish("tasks:all", { action: "delete", data: { seq: 3 } });
      if (harness.waitForDelivery) {
        await harness.waitForDelivery();
      }
      await new Promise(resolve => setTimeout(resolve, 30));

      expect(received2).toEqual(["create:1", "update:2"]);
    });

    it("supports optional ping() and idempotent close()", async () => {
      const harness = await createHarness();
      cleanups.push(harness.cleanup);
      const { pubsub } = harness;

      if (pubsub.ping) {
        await expect(pubsub.ping()).resolves.toBeUndefined();
      }

      await expect(pubsub.close()).resolves.toBeUndefined();
      await expect(pubsub.close()).resolves.toBeUndefined();
    });
  });
}
