export const RBAC_STATEMENTS = {
  user: [
    "create",
    "list",
    "set-role",
    "ban",
    "impersonate",
    "impersonate-admins",
    "delete",
    "set-password",
    "set-email",
    "get",
    "update",
  ],
  session: ["list", "revoke", "delete"],
  task: ["create", "read", "read:any", "update", "update:any", "delete", "delete:any"],
  file: ["create", "read", "read:any", "delete", "delete:any"],
} as const;

export const ROLE_STATEMENTS = {
  user: {
    user: [],
    session: [],
    task: ["create", "read", "update", "delete"],
    file: ["create", "read", "delete"],
  },
  admin: {
    user: [
      "create",
      "list",
      "set-role",
      "ban",
      "impersonate",
      "delete",
      "set-password",
      "set-email",
      "get",
      "update",
    ],
    session: ["list", "revoke", "delete"],
    task: ["create", "read", "read:any", "update", "update:any", "delete", "delete:any"],
    file: ["create", "read", "read:any", "delete", "delete:any"],
  },
} as const;

export type AppRole = keyof typeof ROLE_STATEMENTS;
export type RbacResource = keyof typeof RBAC_STATEMENTS;
export type RbacPermissionMap = {
  [K in RbacResource]?: Array<(typeof RBAC_STATEMENTS)[K][number]>;
};
