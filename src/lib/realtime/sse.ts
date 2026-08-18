import type { Context } from "hono";
import type { RealtimeEvent } from "./pubsub";
import { streamSSE } from "hono/streaming";
import { pubsub } from "./pubsub";

export interface LiveQueryOptions<T> {
  c: Context;
  topic: string | string[] | ((c: Context) => string | string[]);
  fetcher: (c: Context) => Promise<T>;
  eventNames?: {
    init?: string;
    update?: string;
    ping?: string;
  };
  heartbeatIntervalMs?: number;
}

export function createLiveQueryStream<T>(options: LiveQueryOptions<T>) {
  const {
    c,
    topic,
    fetcher,
    eventNames = { init: "update", update: "update", ping: "ping" },
    heartbeatIntervalMs = 15000,
  } = options;

  return streamSSE(c, async (stream) => {
    const topics = typeof topic === "function" ? topic(c) : topic;
    const topicList = Array.isArray(topics) ? topics : [topics];

    let isAborted = false;

    stream.onAbort(() => {
      isAborted = true;
    });

    // 1. Initial query fetch & stream
    try {
      const initialData = await fetcher(c);
      if (!isAborted) {
        await stream.writeSSE({
          event: eventNames.init ?? "update",
          data: JSON.stringify(initialData),
        });
      }
    } catch (err) {
      if (!isAborted) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: (err as Error).message }),
        });
      }
    }

    // 2. Event listener for pubsub changes (Convex style auto re-fetch)
    const unsubscribes: Array<() => void> = [];

    const handleUpdate = async (_eventPayload?: RealtimeEvent) => {
      if (isAborted) return;
      try {
        const newData = await fetcher(c);
        if (!isAborted) {
          await stream.writeSSE({
            event: eventNames.update ?? "update",
            data: JSON.stringify(newData),
          });
        }
      } catch (err) {
        if (!isAborted) {
          await stream.writeSSE({
            event: "error",
            data: JSON.stringify({ message: (err as Error).message }),
          });
        }
      }
    };

    for (const t of topicList) {
      unsubscribes.push(pubsub.subscribe(t, handleUpdate));
    }

    // 3. Keep-alive heartbeat interval
    const timer = setInterval(async () => {
      if (isAborted) {
        clearInterval(timer);
        return;
      }
      try {
        await stream.writeSSE({
          event: eventNames.ping ?? "ping",
          data: JSON.stringify({ timestamp: Date.now() }),
        });
      } catch {
        clearInterval(timer);
      }
    }, heartbeatIntervalMs);

    // Keep stream active until aborted
    while (!isAborted) {
      await stream.sleep(1000);
    }

    clearInterval(timer);
    unsubscribes.forEach(unsub => unsub());
  });
}
