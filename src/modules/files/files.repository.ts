import type { PaginatedResponse } from "@/core/pagination";

export type FileStatus = "pending" | "ready";

export interface FileRecord {
  id: string;
  userId: string;
  key: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string | null;
  status: FileStatus;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface FileScope {
  userId?: string;
}

export interface ListFilesParams {
  userId?: string;
  status?: FileStatus;
  cursor?: string;
  limit?: number;
}

export interface CreateFileInput {
  id?: string;
  userId: string;
  key: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256?: string | null;
  status: FileStatus;
  expiresAt?: Date | null;
}

export interface UpdateFileInput {
  mimeType?: string;
  sizeBytes?: number;
  checksumSha256?: string | null;
  status?: FileStatus;
  expiresAt?: Date | null;
}

export interface FileRepository {
  list: (params: ListFilesParams) => Promise<PaginatedResponse<FileRecord>>;
  findById: (id: string, scope?: FileScope) => Promise<FileRecord | null>;
  create: (input: CreateFileInput) => Promise<FileRecord>;
  update: (id: string, input: UpdateFileInput, scope?: FileScope) => Promise<FileRecord | null>;
  delete: (id: string, scope?: FileScope) => Promise<boolean>;
  findExpiredPending: (now?: Date, limit?: number) => Promise<FileRecord[]>;
  deleteExpiredPending: (now?: Date) => Promise<FileRecord[]>;
}
