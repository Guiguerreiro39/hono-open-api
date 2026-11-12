/* eslint-disable node/no-process-env */

/**
 * Default environment variables pointing at the local Docker Compose
 * `redis` (`localhost:6379`) and RustFS `s3` (`http://localhost:9000`) services.
 *
 * Compatible with `parseEnv(overrides?)` and `createTestApp(overrides?)` while
 * keeping `.env.test` free of external service settings for isolated unit tests.
 */
export const INTEGRATION_ENV_DEFAULTS = {
  REDIS_URL: "redis://localhost:6379",
  STORAGE_DRIVER: "s3",
  S3_BUCKET: "app-uploads",
  S3_REGION: "us-east-1",
  S3_ENDPOINT: "http://localhost:9000",
  S3_PUBLIC_ENDPOINT: "http://localhost:9000",
  S3_ACCESS_KEY_ID: "rustfsadmin",
  S3_SECRET_ACCESS_KEY: "rustfsadmin",
  S3_FORCE_PATH_STYLE: "true",
} as const;

export type IntegrationEnvKey = keyof typeof INTEGRATION_ENV_DEFAULTS;
export type IntegrationEnv = Record<IntegrationEnvKey, string> & Record<string, string | undefined>;

/**
 * Builds integration environment overrides compatible with `parseEnv(overrides?)`.
 * Priority: explicit `overrides` > `baseEnv` (defaults to `process.env`) > `INTEGRATION_ENV_DEFAULTS`.
 */
export function getIntegrationEnv(
  overrides: Record<string, string | undefined> = {},
  baseEnv: Record<string, string | undefined> = process.env,
): IntegrationEnv {
  const resolved: Record<string, string | undefined> = { ...INTEGRATION_ENV_DEFAULTS };

  for (const key of Object.keys(INTEGRATION_ENV_DEFAULTS) as IntegrationEnvKey[]) {
    const value = baseEnv[key];
    if (typeof value === "string" && value.length > 0) {
      resolved[key] = value;
    }
  }

  for (const [key, value] of Object.entries(overrides)) {
    resolved[key] = value;
  }

  return resolved as IntegrationEnv;
}
