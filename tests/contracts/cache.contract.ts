import type { CachePort } from "@/core/ports/cache";
import { afterEach, describe, expect, it } from "vitest";

export interface CacheContractHarness {
  cache: CachePort;
  cleanup: () => Promise<void>;
  advanceTimeMs: (ms: number) => Promise<void>;
}

export function defineCacheContract(
  suiteName: string,
  createHarness: () => Promise<CacheContractHarness>,
) {
  describe(`CachePort contract (${suiteName})`, () => {
    const cleanups: Array<() => Promise<void>> = [];

    afterEach(async () => {
      while (cleanups.length > 0) {
        await cleanups.pop()?.();
      }
    });

    it("returns undefined on misses and round-trips JSON values and cached null distinctly", async () => {
      const harness = await createHarness();
      cleanups.push(harness.cleanup);
      const { cache } = harness;

      expect(await cache.get("users", "missing")).toBeUndefined();

      await cache.set("users", "u1", { id: "u1", active: true, count: 0 });
      expect(await cache.get("users", "u1")).toEqual({ id: "u1", active: true, count: 0 });

      await cache.set("users", "false-val", false);
      expect(await cache.get("users", "false-val")).toBe(false);

      await cache.set("users", "zero-val", 0);
      expect(await cache.get("users", "zero-val")).toBe(0);

      await cache.set("users", "empty-str", "");
      expect(await cache.get("users", "empty-str")).toBe("");

      await cache.set("users", "null-val", null);
      expect(await cache.get("users", "null-val")).toBeNull();
    });

    it("supports getOrSet including negative caching for null values", async () => {
      const harness = await createHarness();
      cleanups.push(harness.cleanup);
      const { cache } = harness;

      let objectLoaderCalls = 0;
      const firstObj = await cache.getOrSet("items", "item-1", async () => {
        objectLoaderCalls++;
        return { name: "Widget" };
      });
      const secondObj = await cache.getOrSet("items", "item-1", async () => {
        objectLoaderCalls++;
        return { name: "Changed" };
      });
      expect(firstObj).toEqual({ name: "Widget" });
      expect(secondObj).toEqual({ name: "Widget" });
      expect(objectLoaderCalls).toBe(1);

      let nullLoaderCalls = 0;
      const firstNull = await cache.getOrSet("items", "missing-item", async () => {
        nullLoaderCalls++;
        return null;
      });
      const secondNull = await cache.getOrSet("items", "missing-item", async () => {
        nullLoaderCalls++;
        return "unexpected";
      });
      expect(firstNull).toBeNull();
      expect(secondNull).toBeNull();
      expect(nullLoaderCalls).toBe(1);
    });

    it("deletes keys, isolates namespaces, and invalidates namespaces in O(1)", async () => {
      const harness = await createHarness();
      cleanups.push(harness.cleanup);
      const { cache } = harness;

      const nsA = cache.scoped("alpha");
      const nsB = cache.scoped("beta");

      await nsA.set("shared-key", "from-alpha");
      await nsA.set("second-key", "still-alpha");
      await nsB.set("shared-key", "from-beta");

      expect(await nsA.get("shared-key")).toBe("from-alpha");
      expect(await nsB.get("shared-key")).toBe("from-beta");

      await nsA.del("second-key");
      expect(await nsA.get("second-key")).toBeUndefined();
      expect(await nsA.get("shared-key")).toBe("from-alpha");

      await nsA.invalidate();
      expect(await nsA.get("shared-key")).toBeUndefined();
      expect(await nsB.get("shared-key")).toBe("from-beta");

      const loadedAfterInvalidate = await nsA.getOrSet("shared-key", async () => "repopulated-alpha");
      expect(loadedAfterInvalidate).toBe("repopulated-alpha");
      expect(await nsA.get("shared-key")).toBe("repopulated-alpha");
    });

    it("expires entries after ttlSeconds and succeeds on ping()", async () => {
      const harness = await createHarness();
      cleanups.push(harness.cleanup);
      const { cache, advanceTimeMs } = harness;

      await cache.ping();
      await cache.set("ephemeral", "short", { ok: true }, 1);
      await cache.set("ephemeral", "longer", { ok: true }, 60);

      expect(await cache.get("ephemeral", "short")).toEqual({ ok: true });
      await advanceTimeMs(1100);

      expect(await cache.get("ephemeral", "short")).toBeUndefined();
      expect(await cache.get("ephemeral", "longer")).toEqual({ ok: true });
    });
  });
}
