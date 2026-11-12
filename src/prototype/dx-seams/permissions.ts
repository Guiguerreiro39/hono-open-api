export const RBAC_STATEMENTS = {
  task: ["create", "read", "read:any", "update", "update:any", "delete", "delete:any"],
  file: ["create", "read", "read:any", "delete", "delete:any"],
} as const;

export const ROLE_STATEMENTS = {
  user: {
    task: ["create", "read", "update", "delete"],
    file: ["create", "read", "delete"],
  },
  admin: {
    task: ["create", "read", "read:any", "update", "update:any", "delete", "delete:any"],
    file: ["create", "read", "read:any", "delete", "delete:any"],
  },
} as const;

export type AppRole = keyof typeof ROLE_STATEMENTS;
export type RbacPermissionMap = {
  [K in keyof typeof RBAC_STATEMENTS]?: Array<(typeof RBAC_STATEMENTS)[K][number]>;
};
