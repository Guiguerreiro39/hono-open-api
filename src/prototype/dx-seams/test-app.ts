import type { AppType } from "./app";
import type { PlatformDeps, PubSubPort, StoragePort } from "./core-types";
import { hc } from "hono/client";
import { testClient } from "hono/testing";

import { createApp } from "./app";
import { createPrototypeAuth } from "./auth-infra";

export async function createPrototypeTestApp() {
  const { auth, db, port: authPort, close: closeAuth } = await createPrototypeAuth();
  const listeners = new Map<string, Set<(e: any) => void | Promise<void>>>();
  const blobs = new Map<string, Uint8Array>();
  const ac = new AbortController();

  const pubsub: PubSubPort = {
    async publish(topic, event) {
      for (const fn of listeners.get(topic) ?? []) {
        await fn(event);
      }
    },
    async subscribe(topic, listener) {
      let set = listeners.get(topic);
      if (!set) {
        set = new Set();
        listeners.set(topic, set);
      }
      set.add(listener);
      return async () => {
        set?.delete(listener);
      };
    },
  };

  const storage: StoragePort = {
    async put(key, body) {
      blobs.set(key, body);
    },
    async get(key) {
      const data = blobs.get(key);
      if (!data) return null;
      return new ReadableStream({
        start(controller) {
          controller.enqueue(data);
          controller.close();
        },
      });
    },
    async delete(key) {
      blobs.delete(key);
    },
    async getSignedPutUrl(key) {
      return `http://localhost/_storage/put?key=${encodeURIComponent(key)}`;
    },
    async getSignedGetUrl(key) {
      return `http://localhost/_storage/get?key=${encodeURIComponent(key)}`;
    },
    async handleSignedRequest(req) {
      const url = new URL(req.url);
      const key = url.searchParams.get("key") ?? "";
      if (req.method === "PUT") {
        blobs.set(key, new Uint8Array(await req.arrayBuffer()));
        return new Response(null, { status: 200 });
      }
      const data = blobs.get(key);
      return data ? new Response(Buffer.from(data), { status: 200 }) : new Response("Not found", { status: 404 });
    },
  };

  const deps: PlatformDeps = {
    appName: "Prototype Starter",
    auth: authPort,
    pubsub,
    storage,
    isShuttingDown: () => ac.signal.aborted,
    shutdownSignal: ac.signal,
  };

  const app = createApp(deps);
  const client = testClient(app);
  const rpcClient = hc<AppType>("http://localhost", {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => app.request(input, init),
  });

  return {
    app,
    client,
    rpcClient,
    auth,
    db,
    deps,
    abortShutdown: () => ac.abort(),
    cleanup: async () => {
      ac.abort();
      await closeAuth();
    },
  };
}
