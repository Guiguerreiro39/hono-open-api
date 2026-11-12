import type { RbacPermissionMap } from "@/core/auth/permissions";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  role: string | null;
  banned: boolean;
  banReason: string | null;
  banExpires: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthSession {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
  impersonatedBy: string | null;
}

export interface AuthSessionResult {
  user: AuthUser;
  session: AuthSession;
}

export interface AuthProfileUpdate {
  name?: string;
  image?: string | null;
}

export interface PruneExpiredAuthResult {
  sessionsDeleted: number;
  verificationsDeleted: number;
}

export interface AuthPort {
  getSession: (headers: Headers) => Promise<AuthSessionResult | null>;
  hasPermission: (params: {
    userId: string;
    role?: string | null;
    permissions: RbacPermissionMap;
  }) => Promise<boolean>;
  updateProfile: (headers: Headers, input: AuthProfileUpdate) => Promise<AuthUser>;
  pruneExpired: (now?: Date) => Promise<PruneExpiredAuthResult>;
  handler: (req: Request) => Promise<Response>;
}
