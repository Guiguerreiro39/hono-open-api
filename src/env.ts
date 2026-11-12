/* eslint-disable node/no-process-env */
import { existsSync } from "node:fs";
import path from "node:path";
import { config as loadDotenv } from "dotenv";
import { expand as expandDotenv } from "dotenv-expand";
import { z } from "zod";

const NodeEnvSchema = z.enum(["development", "test", "production"]);
const LogLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const StorageDriverSchema = z.enum(["memory", "local", "s3"]);

export type StorageDriver = z.infer<typeof StorageDriverSchema>;

const ALLOWED_DB_PROTOCOLS = new Set(["file:", "libsql:", "http:", "https:"]);
const REMOTE_DB_PROTOCOLS = new Set(["libsql:", "https:"]);
const ALLOWED_REDIS_PROTOCOLS = new Set(["redis:", "rediss:"]);

const DEFAULT_LOG_LEVEL_BY_ENV: Record<z.infer<typeof NodeEnvSchema>, z.infer<typeof LogLevelSchema>> = {
  development: "debug",
  test: "silent",
  production: "info",
};

function isValidRedisUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ALLOWED_REDIS_PROTOCOLS.has(parsed.protocol) && parsed.hostname.length > 0;
  }
  catch {
    return false;
  }
}

function isValidDatabaseUrl(value: string): boolean {
  if (value === ":memory:") {
    return true;
  }
  try {
    const parsed = new URL(value);
    if (!ALLOWED_DB_PROTOCOLS.has(parsed.protocol)) {
      return false;
    }
    if (parsed.protocol === "file:") {
      return value.length > "file:".length;
    }
    return parsed.hostname.length > 0;
  }
  catch {
    return false;
  }
}

function isRemoteDatabaseUrl(value: string): boolean {
  if (value === ":memory:") {
    return false;
  }
  try {
    const parsed = new URL(value);
    return REMOTE_DB_PROTOCOLS.has(parsed.protocol);
  }
  catch {
    return false;
  }
}

function emptyToUndefined(value: unknown): unknown {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  return value;
}

function parseBooleanEnv(value: unknown): unknown {
  const normalized = emptyToUndefined(value);
  if (normalized === undefined || typeof normalized === "boolean") {
    return normalized;
  }
  if (typeof normalized === "string") {
    const lower = normalized.trim().toLowerCase();
    if (lower === "true" || lower === "1") {
      return true;
    }
    if (lower === "false" || lower === "0") {
      return false;
    }
  }
  return normalized;
}

function normalizeOrigin(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.origin;
  }
  catch {
    return null;
  }
}

const RawEnvSchema = z.object({
  NODE_ENV: z.preprocess(emptyToUndefined, NodeEnvSchema.default("development")),
  APP_NAME: z.preprocess(emptyToUndefined, z.string().trim().min(1).default("Hono OpenAPI Starter")),
  PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(65535).default(9999)),
  LOG_LEVEL: z.preprocess(emptyToUndefined, LogLevelSchema.optional()),
  DATABASE_URL: z.preprocess(
    emptyToUndefined,
    z.string().trim().refine(isValidDatabaseUrl, {
      message: "Must be ':memory:' or a valid file:, libsql:, http:, or https: URL",
    }).optional(),
  ),
  DATABASE_AUTH_TOKEN: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  CORS_ORIGINS: z.union([z.string(), z.array(z.string())]).optional(),
  READINESS_TIMEOUT_MS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(2000)),
  METRICS_ENABLED: z.preprocess(parseBooleanEnv, z.boolean().default(true)),
  METRICS_TOKEN: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  WORKER_METRICS_PORT: z.preprocess(emptyToUndefined, z.coerce.number().int().min(0).max(65535).optional()),
  BETTER_AUTH_SECRET: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  BETTER_AUTH_URL: z.preprocess(
    emptyToUndefined,
    z.string().trim().refine(value => normalizeOrigin(value) !== null, {
      message: "Must be a valid http:// or https:// URL",
    }).optional(),
  ),
  REDIS_URL: z.preprocess(
    emptyToUndefined,
    z.string().trim().refine(isValidRedisUrl, {
      message: "Must be a valid redis:// or rediss:// URL",
    }).optional(),
  ),
  CACHE_PREFIX: z.preprocess(emptyToUndefined, z.string().trim().min(1).default("app")),
  TRUST_PROXY: z.preprocess(parseBooleanEnv, z.boolean().default(false)),
  RATE_LIMIT_ENABLED: z.preprocess(parseBooleanEnv, z.boolean().optional()),
  STORAGE_DRIVER: z.preprocess(emptyToUndefined, StorageDriverSchema.optional()),
  STORAGE_LOCAL_DIR: z.preprocess(emptyToUndefined, z.string().trim().min(1).default("./.storage")),
  STORAGE_MAX_FILE_SIZE_BYTES: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(10_485_760)),
  STORAGE_PRESIGN_MAX_FILE_SIZE_BYTES: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(104_857_600)),
  STORAGE_PRESIGN_EXPIRES_SECONDS: z.preprocess(emptyToUndefined, z.coerce.number().int().positive().default(900)),
  STORAGE_SIGNING_SECRET: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  S3_BUCKET: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  S3_REGION: z.preprocess(emptyToUndefined, z.string().trim().min(1).default("us-east-1")),
  S3_ENDPOINT: z.preprocess(
    emptyToUndefined,
    z.string().trim().refine(value => normalizeOrigin(value) !== null, {
      message: "Must be a valid http:// or https:// URL",
    }).optional(),
  ),
  S3_PUBLIC_ENDPOINT: z.preprocess(
    emptyToUndefined,
    z.string().trim().refine(value => normalizeOrigin(value) !== null, {
      message: "Must be a valid http:// or https:// URL",
    }).optional(),
  ),
  S3_ACCESS_KEY_ID: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  S3_SECRET_ACCESS_KEY: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  S3_FORCE_PATH_STYLE: z.preprocess(parseBooleanEnv, z.boolean().default(false)),
});

export interface Env {
  NODE_ENV: z.infer<typeof NodeEnvSchema>;
  APP_NAME: string;
  PORT: number;
  LOG_LEVEL: z.infer<typeof LogLevelSchema>;
  DATABASE_URL: string;
  DATABASE_AUTH_TOKEN?: string;
  CORS_ORIGINS: string[];
  READINESS_TIMEOUT_MS: number;
  METRICS_ENABLED: boolean;
  METRICS_TOKEN?: string;
  WORKER_METRICS_PORT?: number;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  REDIS_URL?: string;
  CACHE_PREFIX: string;
  TRUST_PROXY: boolean;
  RATE_LIMIT_ENABLED: boolean;
  STORAGE_DRIVER: StorageDriver;
  STORAGE_LOCAL_DIR: string;
  STORAGE_MAX_FILE_SIZE_BYTES: number;
  STORAGE_PRESIGN_MAX_FILE_SIZE_BYTES: number;
  STORAGE_PRESIGN_EXPIRES_SECONDS: number;
  STORAGE_SIGNING_SECRET: string;
  S3_BUCKET?: string;
  S3_REGION: string;
  S3_ENDPOINT?: string;
  S3_PUBLIC_ENDPOINT?: string;
  S3_ACCESS_KEY_ID?: string;
  S3_SECRET_ACCESS_KEY?: string;
  S3_FORCE_PATH_STYLE: boolean;
}

export interface EnvOverrides extends Partial<Record<keyof Env, string | number | boolean | string[] | undefined>> {}

export const EnvSchema = RawEnvSchema.transform((input, ctx): Env => {
  const logLevel = input.LOG_LEVEL ?? DEFAULT_LOG_LEVEL_BY_ENV[input.NODE_ENV];
  const databaseUrl = input.DATABASE_URL
    ?? (input.NODE_ENV === "test"
      ? ":memory:"
      : input.NODE_ENV === "development"
        ? "file:dev.db"
        : undefined);

  if (!databaseUrl) {
    ctx.addIssue({
      code: "custom",
      path: ["DATABASE_URL"],
      message: "DATABASE_URL is required when NODE_ENV is 'production'",
    });
    return z.NEVER;
  }

  if (input.NODE_ENV === "production" && isRemoteDatabaseUrl(databaseUrl) && !input.DATABASE_AUTH_TOKEN) {
    ctx.addIssue({
      code: "custom",
      path: ["DATABASE_AUTH_TOKEN"],
      message: "DATABASE_AUTH_TOKEN is required in 'production' for libsql:// and https:// URLs",
    });
    return z.NEVER;
  }

  const betterAuthSecret = input.BETTER_AUTH_SECRET
    ?? (input.NODE_ENV === "production" ? undefined : "secret");

  if (!betterAuthSecret) {
    ctx.addIssue({
      code: "custom",
      path: ["BETTER_AUTH_SECRET"],
      message: "BETTER_AUTH_SECRET is required when NODE_ENV is 'production'",
    });
    return z.NEVER;
  }

  if (input.NODE_ENV === "production" && (betterAuthSecret === "secret" || betterAuthSecret.length < 32)) {
    ctx.addIssue({
      code: "custom",
      path: ["BETTER_AUTH_SECRET"],
      message: "BETTER_AUTH_SECRET must be at least 32 characters and not 'secret' in 'production'",
    });
    return z.NEVER;
  }

  const betterAuthUrl = input.BETTER_AUTH_URL
    ?? (input.NODE_ENV === "production" ? undefined : "http://localhost:9999");

  if (!betterAuthUrl) {
    ctx.addIssue({
      code: "custom",
      path: ["BETTER_AUTH_URL"],
      message: "BETTER_AUTH_URL is required when NODE_ENV is 'production'",
    });
    return z.NEVER;
  }

  if (input.NODE_ENV === "production" && !input.REDIS_URL) {
    ctx.addIssue({
      code: "custom",
      path: ["REDIS_URL"],
      message: "REDIS_URL is required when NODE_ENV is 'production'",
    });
    return z.NEVER;
  }

  const rateLimitEnabled = input.RATE_LIMIT_ENABLED ?? (input.NODE_ENV !== "test");

  let corsOrigins: string[];
  if (input.CORS_ORIGINS === undefined) {
    corsOrigins = input.NODE_ENV === "production" ? [] : ["http://localhost:3000"];
  }
  else {
    const rawItems = Array.isArray(input.CORS_ORIGINS)
      ? input.CORS_ORIGINS
      : input.CORS_ORIGINS.split(",");
    const normalized: string[] = [];
    for (const item of rawItems) {
      const trimmed = item.trim();
      if (trimmed.length === 0) {
        continue;
      }
      const origin = normalizeOrigin(trimmed);
      if (!origin) {
        ctx.addIssue({
          code: "custom",
          path: ["CORS_ORIGINS"],
          message: `Invalid CORS origin: '${trimmed}'`,
        });
        return z.NEVER;
      }
      normalized.push(origin);
    }
    corsOrigins = normalized;
  }

  const storageDriver: StorageDriver = input.STORAGE_DRIVER
    ?? (input.NODE_ENV === "test"
      ? "memory"
      : input.NODE_ENV === "production"
        ? "s3"
        : input.S3_BUCKET
          ? "s3"
          : "local");

  if (storageDriver === "s3" && !input.S3_BUCKET) {
    ctx.addIssue({
      code: "custom",
      path: ["S3_BUCKET"],
      message: "S3_BUCKET is required when STORAGE_DRIVER is 's3'",
    });
    return z.NEVER;
  }

  const hasAccessKeyId = input.S3_ACCESS_KEY_ID !== undefined;
  const hasSecretAccessKey = input.S3_SECRET_ACCESS_KEY !== undefined;
  if (hasAccessKeyId !== hasSecretAccessKey) {
    ctx.addIssue({
      code: "custom",
      path: [hasAccessKeyId ? "S3_SECRET_ACCESS_KEY" : "S3_ACCESS_KEY_ID"],
      message: "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must both be set or both be omitted",
    });
    return z.NEVER;
  }

  const storageSigningSecret = input.STORAGE_SIGNING_SECRET ?? betterAuthSecret;

  return {
    NODE_ENV: input.NODE_ENV,
    APP_NAME: input.APP_NAME,
    PORT: input.PORT,
    LOG_LEVEL: logLevel,
    DATABASE_URL: databaseUrl,
    DATABASE_AUTH_TOKEN: input.DATABASE_AUTH_TOKEN,
    CORS_ORIGINS: corsOrigins,
    READINESS_TIMEOUT_MS: input.READINESS_TIMEOUT_MS,
    METRICS_ENABLED: input.METRICS_ENABLED,
    METRICS_TOKEN: input.METRICS_TOKEN,
    WORKER_METRICS_PORT: input.WORKER_METRICS_PORT,
    BETTER_AUTH_SECRET: betterAuthSecret,
    BETTER_AUTH_URL: betterAuthUrl,
    REDIS_URL: input.REDIS_URL,
    CACHE_PREFIX: input.CACHE_PREFIX,
    TRUST_PROXY: input.TRUST_PROXY,
    RATE_LIMIT_ENABLED: rateLimitEnabled,
    STORAGE_DRIVER: storageDriver,
    STORAGE_LOCAL_DIR: input.STORAGE_LOCAL_DIR,
    STORAGE_MAX_FILE_SIZE_BYTES: input.STORAGE_MAX_FILE_SIZE_BYTES,
    STORAGE_PRESIGN_MAX_FILE_SIZE_BYTES: input.STORAGE_PRESIGN_MAX_FILE_SIZE_BYTES,
    STORAGE_PRESIGN_EXPIRES_SECONDS: input.STORAGE_PRESIGN_EXPIRES_SECONDS,
    STORAGE_SIGNING_SECRET: storageSigningSecret,
    S3_BUCKET: input.S3_BUCKET,
    S3_REGION: input.S3_REGION,
    S3_ENDPOINT: input.S3_ENDPOINT,
    S3_PUBLIC_ENDPOINT: input.S3_PUBLIC_ENDPOINT,
    S3_ACCESS_KEY_ID: input.S3_ACCESS_KEY_ID,
    S3_SECRET_ACCESS_KEY: input.S3_SECRET_ACCESS_KEY,
    S3_FORCE_PATH_STYLE: input.S3_FORCE_PATH_STYLE,
  };
});

export class EnvValidationError extends Error {
  readonly issues: z.core.$ZodIssue[];
  readonly fieldErrors: Record<string, string[] | undefined>;

  constructor(error: z.ZodError) {
    const flattened = z.flattenError(error);
    super(`Invalid environment variables: ${JSON.stringify(flattened.fieldErrors)}`);
    this.name = "EnvValidationError";
    this.issues = error.issues;
    this.fieldErrors = flattened.fieldErrors;
  }
}

function readEnvFile(nodeEnv: string | undefined): Record<string, string> {
  const filename = nodeEnv === "test" ? ".env.test" : ".env";
  const filePath = path.resolve(process.cwd(), filename);
  if (!existsSync(filePath)) {
    return {};
  }
  const target: Record<string, string> = {};
  const loaded = loadDotenv({
    path: filePath,
    processEnv: target,
    quiet: true,
  });
  if (loaded.parsed) {
    expandDotenv({
      processEnv: target,
      parsed: loaded.parsed,
    });
  }
  return target;
}

export function parseEnv(overrides?: EnvOverrides): Env {
  const fileEnv = overrides === undefined ? readEnvFile(process.env.NODE_ENV) : {};
  const candidate: Record<string, unknown> = {
    ...fileEnv,
    ...process.env,
    ...overrides,
  };

  const result = EnvSchema.safeParse(candidate);
  if (!result.success) {
    throw new EnvValidationError(result.error);
  }
  return result.data;
}

export interface LoadEnvOptions {
  overrides?: EnvOverrides;
  writeStderr?: (chunk: string) => void;
  exit?: (code: number) => never;
}

export function loadEnv(options?: LoadEnvOptions): Env {
  try {
    return parseEnv(options?.overrides);
  }
  catch (err) {
    const write = options?.writeStderr ?? (chunk => process.stderr.write(chunk));
    const exit = options?.exit ?? (code => process.exit(code));
    if (err instanceof EnvValidationError) {
      write(`Invalid environment configuration:\n${JSON.stringify(err.fieldErrors, null, 2)}\n`);
    }
    else {
      write(`Invalid environment configuration: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    return exit(1);
  }
}
