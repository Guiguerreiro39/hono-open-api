import type { MiddlewareHandler } from "hono";
import type { HonoConfigType, RedisClient, Store } from "hono-rate-limiter";
import type { Redis } from "ioredis";
import type { Buffer } from "node:buffer";
import type { Logger } from "pino";

import type { MetricsPort } from "@/core/ports/metrics";
import type {
  RateLimitConsumeResult,
  RateLimiterMiddlewareOptions,
  RateLimiterPort,
  RateLimitPolicy,
  RateLimitTier,
} from "@/core/ports/rate-limit";
import type { AppBindings } from "@/core/types";
import { MemoryStore, rateLimiter, RedisStore } from "hono-rate-limiter";

import { RateLimitError } from "@/core/errors";

class StoreUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Rate limit store unavailable", { cause });
    this.name = "StoreUnavailableError";
  }
}

export function buildRateLimitPrefix(prefix: string, tier: RateLimitTier): string {
  return `${prefix}:rl:${tier}:`;
}

export function toHonoRateLimiterClient(redis: Redis): RedisClient {
  return {
    scriptLoad: script => redis.script("LOAD", script) as Promise<string>,
    evalsha: <TArgs extends unknown[], TData = unknown>(
      sha1: string,
      keys: string[],
      args: TArgs,
    ) =>
      redis.evalsha(
        sha1,
        keys.length,
        ...keys,
        ...(args as Array<string | number | Buffer>),
      ) as Promise<TData>,
    decr: key => redis.decr(key),
    del: key => redis.del(key),
  };
}

interface StoredBucket {
  tier: RateLimitTier;
  store: Store<AppBindings>;
  initialized: boolean;
}

interface StoreBackedOptions {
  metrics?: MetricsPort;
  logger?: Logger;
  failOpen: boolean;
  createStore: (tier: RateLimitTier) => Store<AppBindings>;
  fallbackResetKey?: (tier: RateLimitTier, key: string) => Promise<void>;
}

class StoreBackedRateLimiter implements RateLimiterPort {
  private readonly stores = new Map<string, StoredBucket>();
  private readonly metrics?: MetricsPort;
  private readonly logger?: Logger;
  private readonly failOpen: boolean;
  private readonly createStore: (tier: RateLimitTier) => Store<AppBindings>;
  private readonly fallbackResetKey?: (tier: RateLimitTier, key: string) => Promise<void>;

  constructor(options: StoreBackedOptions) {
    this.metrics = options.metrics;
    this.logger = options.logger;
    this.failOpen = options.failOpen;
    this.createStore = options.createStore;
    this.fallbackResetKey = options.fallbackResetKey;
  }

  private getBucket(tier: RateLimitTier, windowMs: number, initOnCreate: boolean): StoredBucket {
    const mapKey = `${tier}:${windowMs}`;
    let bucket = this.stores.get(mapKey);
    if (!bucket) {
      bucket = {
        tier,
        store: this.createStore(tier),
        initialized: false,
      };
      this.stores.set(mapKey, bucket);
    }

    if (initOnCreate && !bucket.initialized) {
      bucket.store.init?.({ windowMs } as HonoConfigType<AppBindings>);
      bucket.initialized = true;
    }

    return bucket;
  }

  async consume(policy: RateLimitPolicy, key: string): Promise<RateLimitConsumeResult> {
    const bucket = this.getBucket(policy.tier, policy.windowMs, true);

    try {
      const info = await bucket.store.increment(key);
      const allowed = info.totalHits <= policy.limit;
      const remaining = Math.max(policy.limit - info.totalHits, 0);

      this.metrics?.recordRateLimit({
        tier: policy.tier,
        decision: allowed ? "allowed" : "limited",
      });

      return {
        allowed,
        limit: policy.limit,
        remaining,
        resetTime: info.resetTime,
      };
    }
    catch (err) {
      if (!this.failOpen) {
        throw err;
      }

      this.logger?.warn(
        { err, tier: policy.tier, key },
        "Redis rate limiter failed; failing open",
      );
      this.metrics?.recordRateLimit({ tier: policy.tier, decision: "error" });

      return {
        allowed: true,
        limit: policy.limit,
        remaining: policy.limit,
        failedOpen: true,
      };
    }
  }

  middleware(options: RateLimiterMiddlewareOptions): MiddlewareHandler<AppBindings> {
    const bucket = this.getBucket(options.tier, options.windowMs, false);

    const wrappedStore: Store<AppBindings> = {
      localKeys: bucket.store.localKeys,
      prefix: bucket.store.prefix,
      init: (config) => {
        bucket.store.init?.(config);
        bucket.initialized = true;
      },
      get: bucket.store.get ? key => bucket.store.get!(key) : undefined,
      increment: async (key) => {
        try {
          return await bucket.store.increment(key);
        }
        catch (err) {
          if (this.failOpen) {
            throw new StoreUnavailableError(err);
          }
          throw err;
        }
      },
      decrement: async (key) => {
        try {
          await bucket.store.decrement(key);
        }
        catch (err) {
          if (!this.failOpen) {
            throw err;
          }
          this.logger?.warn({ err, tier: options.tier, key }, "Redis rate limiter decrement failed");
        }
      },
      resetKey: async (key) => {
        try {
          await bucket.store.resetKey(key);
        }
        catch (err) {
          if (!this.failOpen) {
            throw err;
          }
          this.logger?.warn({ err, tier: options.tier, key }, "Redis rate limiter resetKey failed");
        }
      },
      shutdown: bucket.store.shutdown ? () => bucket.store.shutdown!() : undefined,
    };

    const limiter = rateLimiter<AppBindings>({
      windowMs: options.windowMs,
      limit: options.limit,
      standardHeaders: "draft-7",
      keyGenerator: options.keyGenerator,
      skip: () => false,
      store: wrappedStore,
      handler: () => {
        this.metrics?.recordRateLimit({ tier: options.tier, decision: "limited" });
        throw new RateLimitError("Too many requests");
      },
    });

    return async (c, next) => {
      if (options.skip && (await options.skip(c))) {
        return next();
      }

      try {
        return await limiter(c, async () => {
          this.metrics?.recordRateLimit({ tier: options.tier, decision: "allowed" });
          await next();
        });
      }
      catch (err) {
        if (err instanceof StoreUnavailableError) {
          this.logger?.warn(
            { err: err.cause, tier: options.tier },
            "Redis rate limiter failed; failing open",
          );
          this.metrics?.recordRateLimit({ tier: options.tier, decision: "error" });
          return next();
        }
        throw err;
      }
    };
  }

  async resetKey(tier: RateLimitTier, key: string): Promise<void> {
    let matched = false;
    for (const bucket of this.stores.values()) {
      if (bucket.tier !== tier) {
        continue;
      }
      matched = true;
      try {
        await bucket.store.resetKey(key);
      }
      catch (err) {
        if (!this.failOpen) {
          throw err;
        }
        this.logger?.warn({ err, tier, key }, "Redis rate limiter resetKey failed");
      }
    }

    if (!matched && this.fallbackResetKey) {
      await this.fallbackResetKey(tier, key);
    }
  }

  readonly close = async (): Promise<void> => {
    for (const bucket of this.stores.values()) {
      await bucket.store.shutdown?.();
    }
    this.stores.clear();
  };
}

export interface MemoryRateLimiterAdapterOptions {
  metrics?: MetricsPort;
}

export class MemoryRateLimiterAdapter extends StoreBackedRateLimiter {
  constructor(options?: MemoryRateLimiterAdapterOptions) {
    super({
      metrics: options?.metrics,
      failOpen: false,
      createStore: () => new MemoryStore<AppBindings>(),
    });
  }
}

export interface RedisRateLimiterAdapterOptions {
  client: Redis;
  prefix?: string;
  logger: Logger;
  metrics?: MetricsPort;
}

export class RedisRateLimiterAdapter extends StoreBackedRateLimiter {
  constructor(options: RedisRateLimiterAdapterOptions) {
    const prefix = options.prefix ?? "app";
    const hrlClient = toHonoRateLimiterClient(options.client);

    super({
      metrics: options.metrics,
      logger: options.logger,
      failOpen: true,
      createStore: tier => new RedisStore<AppBindings>({
        client: hrlClient,
        prefix: buildRateLimitPrefix(prefix, tier),
      }),
      fallbackResetKey: async (tier, key) => {
        try {
          await options.client.del(`${buildRateLimitPrefix(prefix, tier)}${key}`);
        }
        catch (err) {
          options.logger.warn({ err, tier, key }, "Redis rate limiter resetKey failed");
        }
      },
    });
  }
}
