import type { Logger } from "pino";
import type { PubSubPort, RealtimeEvent, RealtimeEventListener } from "@/core/ports/pubsub";
import type { RedisLifecycleClient } from "@/infra/redis";
import { EventEmitter } from "node:events";
import { awaitRedisHandshake, quitRedisClient } from "@/infra/redis";

export interface RedisPubSubClient extends RedisLifecycleClient {
  options?: {
    connectionName?: string;
    maxRetriesPerRequest?: number | null;
  };
  duplicate: (override?: {
    connectionName?: string;
    maxRetriesPerRequest?: number | null;
  }) => RedisPubSubClient;
  publish: (channel: string, message: string) => Promise<number>;
  subscribe: (...channels: string[]) => Promise<unknown>;
  unsubscribe: (...channels: string[]) => Promise<unknown>;
  ping: () => Promise<string>;
  on: (event: string, listener: (...args: any[]) => void) => unknown;
}

export interface RedisPubSubAdapterOptions {
  pub: RedisPubSubClient;
  prefix?: string;
  logger: Logger;
  ping?: () => Promise<void>;
}

export function buildPubSubChannel(prefix: string, topic: string): string {
  return `${prefix}:pubsub:${topic}`;
}

export class RedisPubSubAdapter implements PubSubPort {
  readonly prefix: string;

  private readonly pub: RedisPubSubClient;
  private readonly sub: RedisPubSubClient;
  private readonly logger: Logger;
  private readonly pingFn: () => Promise<void>;
  private readonly emitter = new EventEmitter();
  private readonly topicLocks = new Map<string, Promise<void>>();
  private readonly channelPrefix: string;
  private closed = false;

  private readonly onPubError = (err: Error) => {
    this.logger.warn({ err, role: "pub" }, "Redis pubsub client error");
  };

  private readonly onSubError = (err: Error) => {
    this.logger.warn({ err, role: "sub" }, "Redis pubsub client error");
  };

  private readonly onMessage = (channel: string, rawMessage: string) => {
    if (this.closed || !channel.startsWith(this.channelPrefix)) {
      return;
    }
    const topic = channel.slice(this.channelPrefix.length);
    let parsed: RealtimeEvent;
    try {
      parsed = JSON.parse(rawMessage) as RealtimeEvent;
    }
    catch (err) {
      this.logger.warn({ err, topic, channel }, "Failed to parse Redis pubsub message");
      return;
    }
    this.emitter.emit(topic, parsed);
  };

  constructor(options: RedisPubSubAdapterOptions) {
    this.pub = options.pub;
    this.prefix = options.prefix ?? "app";
    this.channelPrefix = `${this.prefix}:pubsub:`;
    this.logger = options.logger;
    this.emitter.setMaxListeners(0);

    const subConnectionName = options.pub.options?.connectionName
      ? `${options.pub.options.connectionName}:pubsub`
      : "pubsub";

    this.sub = options.pub.duplicate({
      connectionName: subConnectionName,
      maxRetriesPerRequest: null,
    });

    this.pub.on("error", this.onPubError);
    this.sub.on("error", this.onSubError);
    this.sub.on("message", this.onMessage);

    this.pingFn = options.ping ?? (async () => {
      if (this.pub.status === "wait" || this.pub.status === "connecting") {
        await awaitRedisHandshake(this.pub);
      }
      await this.pub.ping();
    });
  }

  private withTopicLock<T>(topic: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.topicLocks.get(topic) ?? Promise.resolve();
    const current = previous.then(fn, fn);
    const tail = current.then(
      () => {
        if (this.topicLocks.get(topic) === tail) {
          this.topicLocks.delete(topic);
        }
      },
      () => {
        if (this.topicLocks.get(topic) === tail) {
          this.topicLocks.delete(topic);
        }
      },
    );
    this.topicLocks.set(topic, tail);
    return current;
  }

  async publish<T = unknown>(topic: string, event: RealtimeEvent<T>): Promise<void> {
    if (this.closed) {
      return;
    }
    const channel = buildPubSubChannel(this.prefix, topic);
    const payload: RealtimeEvent<T> = {
      ...event,
      timestamp: event.timestamp ?? Date.now(),
    };

    try {
      await this.pub.publish(channel, JSON.stringify(payload));
    }
    catch (err) {
      this.logger.warn({ err, topic, channel }, "Redis pubsub publish error; failing open");
    }
  }

  async subscribe<T = unknown>(
    topic: string,
    listener: RealtimeEventListener<T>,
  ): Promise<() => Promise<void>> {
    const channel = buildPubSubChannel(this.prefix, topic);

    const wrapped = (event: RealtimeEvent<T>) => {
      try {
        const result = listener(event);
        if (result instanceof Promise) {
          void result.catch((err) => {
            this.logger.warn({ err, topic }, "Redis pubsub listener rejected");
          });
        }
      }
      catch (err) {
        this.logger.warn({ err, topic }, "Redis pubsub listener threw");
      }
    };

    await this.withTopicLock(topic, async () => {
      if (this.closed) {
        throw new Error("RedisPubSubAdapter is closed");
      }
      if (this.emitter.listenerCount(topic) === 0) {
        if (this.sub.status === "wait" || this.sub.status === "connecting") {
          await awaitRedisHandshake(this.sub);
        }
        await this.sub.subscribe(channel);
      }
      this.emitter.on(topic, wrapped);
    });

    let active = true;
    return async () => {
      await this.withTopicLock(topic, async () => {
        if (!active) {
          return;
        }
        active = false;
        this.emitter.off(topic, wrapped);

        if (!this.closed && this.emitter.listenerCount(topic) === 0) {
          try {
            await this.sub.unsubscribe(channel);
          }
          catch (err) {
            this.logger.warn({ err, topic, channel }, "Redis pubsub unsubscribe error");
          }
        }
      });
    };
  }

  listenerCount(topic: string): number {
    return this.emitter.listenerCount(topic);
  }

  async ping(): Promise<void> {
    await this.pingFn();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.emitter.removeAllListeners();
    this.pub.off("error", this.onPubError);
    this.sub.off("message", this.onMessage);
    await quitRedisClient(this.sub);
    this.sub.off("error", this.onSubError);
  }
}
