import type { AppOpenAPI } from "./types";

// From prototype branch gg/prototype/dx-seams: inline literals widen RouteConfig generics.
export const AUTH_SECURITY: Array<Record<string, string[]>> = [
  { bearerAuth: [] },
  { cookieAuth: [] },
];

export const OPENAPI_VERSION = "3.0.0";
export const API_VERSION = "1.0.0";

export function registerOpenAPISecuritySchemes(app: AppOpenAPI): void {
  app.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
    type: "http",
    scheme: "bearer",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "cookieAuth", {
    type: "apiKey",
    in: "cookie",
    name: "better-auth.session_token",
  });
}

export function createOpenAPIDocumentConfig(appName: string) {
  return {
    openapi: OPENAPI_VERSION,
    info: {
      version: API_VERSION,
      title: appName,
    },
  };
}
