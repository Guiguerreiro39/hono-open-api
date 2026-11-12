import type { Logger } from "pino";
import type { PubSubPort, RealtimeEvent, RealtimeEventListener } from "@/core/ports/pubsub";
import { EventEmitter } from "node:events";

export interface MemoryPubSubAdapterOptions {
  logger?: Logger;
}

export class MemoryPubSubAdapter implements PubSubPort {
  private readonly emitter = new EventEmitter();
  private readonly logger?: Logger;
  private closed = false;

  constructor(options?: MemoryPubSubAdapterOptions) {
    this.logger = options?.logger;
    this.emitter.setMaxListeners(0);
  }

  async publish<T = unknown>(topic: string, event: RealtimeEvent<T>): Promise<void> {
    if (this.closed) {
      return;
    }

    const payload: RealtimeEvent<T> = {
      ...event,
      timestamp: event.timestamp ?? Date.now(),
    };
    this.emitter.emit(topic, payload);
  }

  async subscribe<T = unknown>(
    topic: string,
    listener: RealtimeEventListener<T>,
  ): Promise<() => Promise<void>> {
    if (this.closed) {
      throw new Error("MemoryPubSubAdapter is closed");
    }

    const wrapped = (event: RealtimeEvent<T>) => {
      try {
        const result = listener(event);
        if (result instanceof Promise) {
          void result.catch((err) => {
            this.logger?.warn({ err, topic }, "PubSub listener rejected");
          });
        }
      }
      catch (err) {
        this.logger?.warn({ err, topic }, "PubSub listener threw");
      }
    };

    this.emitter.on(topic, wrapped);

    let active = true;
    return async () => {
      if (!active) {
        return;
      }
      active = false;
      this.emitter.off(topic, wrapped);
    };
  }

  listenerCount(topic: string): number {
    return this.emitter.listenerCount(topic);
  }

  clear(): void {
    this.emitter.removeAllListeners();
  }

  async ping(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
    this.clear();
  }
}
