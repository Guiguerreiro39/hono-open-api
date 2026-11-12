import type { StoragePort } from "@/core/ports/storage";
import type { Env } from "@/env";

import { createLocalStorageAdapter } from "./local";
import { createMemoryStorageAdapter } from "./memory";
import { createS3StorageAdapter } from "./s3";

export { createLocalStorageAdapter, LocalStorageAdapter } from "./local";
export { createMemoryStorageAdapter, MemoryStorageAdapter } from "./memory";
export { createS3StorageAdapter, S3StorageAdapter } from "./s3";

export type StorageAdapterEnv = Pick<
  Env,
  | "STORAGE_DRIVER"
  | "STORAGE_LOCAL_DIR"
  | "STORAGE_PRESIGN_MAX_FILE_SIZE_BYTES"
  | "STORAGE_PRESIGN_EXPIRES_SECONDS"
  | "STORAGE_SIGNING_SECRET"
  | "BETTER_AUTH_URL"
  | "S3_BUCKET"
  | "S3_REGION"
  | "S3_ENDPOINT"
  | "S3_PUBLIC_ENDPOINT"
  | "S3_ACCESS_KEY_ID"
  | "S3_SECRET_ACCESS_KEY"
  | "S3_FORCE_PATH_STYLE"
>;

export function createStorageAdapter(env: StorageAdapterEnv): {
  port: StoragePort;
  close: () => Promise<void>;
} {
  switch (env.STORAGE_DRIVER) {
    case "memory": {
      const adapter = createMemoryStorageAdapter({
        signingSecret: env.STORAGE_SIGNING_SECRET,
        baseUrl: env.BETTER_AUTH_URL,
        defaultExpiresInSeconds: env.STORAGE_PRESIGN_EXPIRES_SECONDS,
        maxPresignBytes: env.STORAGE_PRESIGN_MAX_FILE_SIZE_BYTES,
      });
      return {
        port: adapter,
        close: async () => {},
      };
    }

    case "local": {
      const adapter = createLocalStorageAdapter({
        rootDir: env.STORAGE_LOCAL_DIR,
        signingSecret: env.STORAGE_SIGNING_SECRET,
        baseUrl: env.BETTER_AUTH_URL,
        defaultExpiresInSeconds: env.STORAGE_PRESIGN_EXPIRES_SECONDS,
        maxPresignBytes: env.STORAGE_PRESIGN_MAX_FILE_SIZE_BYTES,
      });
      return {
        port: adapter,
        close: async () => {},
      };
    }

    case "s3": {
      if (!env.S3_BUCKET) {
        throw new Error("S3_BUCKET is required when STORAGE_DRIVER is 's3'");
      }
      const adapter = createS3StorageAdapter({
        bucket: env.S3_BUCKET,
        region: env.S3_REGION,
        endpoint: env.S3_ENDPOINT,
        publicEndpoint: env.S3_PUBLIC_ENDPOINT,
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
        defaultExpiresInSeconds: env.STORAGE_PRESIGN_EXPIRES_SECONDS,
      });
      return {
        port: adapter,
        close: () => adapter.close(),
      };
    }
  }
}
