import type { FileRecord, FileRepository, FileScope } from "./files.repository";
import type { FileDto, ListFilesQuery, PresignFileDto } from "./files.schema";
import type { PaginatedResponse } from "@/core/pagination";
import type { AuthUser } from "@/core/ports/auth";
import type { PlatformDeps } from "@/core/types";
import { createHash } from "node:crypto";

import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
} from "@/core/errors";
import { filesDeleteObjectJob } from "./files.jobs";
import {
  buildAttachmentDisposition,
  isAllowedMimeType,
  MAGIC_BYTE_READ_LIMIT,
  normalizeMimeType,
  sanitizeOriginalName,
  validateMagicBytes,
} from "./files.validation";

export interface FilesServiceDeps {
  auth: PlatformDeps["auth"];
  storage: PlatformDeps["storage"];
  queue: PlatformDeps["queue"];
  logger: PlatformDeps["logger"];
  env: Pick<
    PlatformDeps["env"],
    | "STORAGE_MAX_FILE_SIZE_BYTES"
    | "STORAGE_PRESIGN_MAX_FILE_SIZE_BYTES"
    | "STORAGE_PRESIGN_EXPIRES_SECONDS"
  >;
  fileRepository: FileRepository;
}

export interface PresignedUploadResult {
  file: FileRecord;
  uploadUrl: string;
}

export interface FileDownloadStream {
  file: FileRecord;
  stream: ReadableStream<Uint8Array>;
  contentDisposition: string;
}

export interface FileDownloadUrlResult {
  url: string;
  expiresInSeconds: number;
}

export interface FilesService {
  listFiles: (user: AuthUser, query: ListFilesQuery) => Promise<PaginatedResponse<FileRecord>>;
  uploadMultipart: (user: AuthUser, file: File) => Promise<FileRecord>;
  createPresignedUpload: (user: AuthUser, input: PresignFileDto) => Promise<PresignedUploadResult>;
  completeUpload: (user: AuthUser, id: string) => Promise<FileRecord>;
  downloadFile: (user: AuthUser, id: string) => Promise<FileDownloadStream>;
  getDownloadUrl: (user: AuthUser, id: string) => Promise<FileDownloadUrlResult>;
  deleteFile: (user: AuthUser, id: string) => Promise<void>;
}

async function readStreamUpTo(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) {
        break;
      }
      const remaining = maxBytes - total;
      const slice = value.byteLength > remaining ? value.subarray(0, remaining) : value;
      chunks.push(slice);
      total += slice.byteLength;
    }
  }
  finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export function formatFileDto(record: FileRecord): FileDto {
  return {
    id: record.id,
    userId: record.userId,
    originalName: record.originalName,
    mimeType: record.mimeType,
    sizeBytes: record.sizeBytes,
    checksumSha256: record.checksumSha256,
    status: record.status,
    expiresAt: record.expiresAt ? record.expiresAt.toISOString() : null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function createFilesService(deps: FilesServiceDeps): FilesService {
  async function hasPermission(
    user: AuthUser,
    action: "create" | "read" | "read:any" | "delete" | "delete:any",
  ): Promise<boolean> {
    return deps.auth.hasPermission({
      userId: user.id,
      role: user.role,
      permissions: { file: [action] },
    });
  }

  async function assertPermission(
    user: AuthUser,
    action: "create" | "read" | "read:any" | "delete" | "delete:any",
  ): Promise<void> {
    if (!(await hasPermission(user, action))) {
      throw new ForbiddenError("Insufficient permissions");
    }
  }

  async function resolveScope(
    user: AuthUser,
    anyAction: "read:any" | "delete:any",
  ): Promise<FileScope | undefined> {
    const canBypassOwnership = await hasPermission(user, anyAction);
    return canBypassOwnership ? undefined : { userId: user.id };
  }

  async function findReadyFileForRead(user: AuthUser, id: string): Promise<FileRecord> {
    await assertPermission(user, "read");
    const scope = await resolveScope(user, "read:any");
    const record = await deps.fileRepository.findById(id, scope);
    if (!record) {
      throw new NotFoundError("File not found");
    }
    if (record.status !== "ready") {
      throw new ConflictError("File upload is not complete", { code: "FILE_PENDING" });
    }
    return record;
  }

  async function deleteObjectBestEffort(key: string): Promise<void> {
    try {
      await deps.storage.delete(key);
    }
    catch (err) {
      deps.logger.warn({ err, key }, "Failed to delete storage object; enqueueing cleanup retry");
      await deps.queue.enqueue(filesDeleteObjectJob, { key });
    }
  }

  return {
    async listFiles(user, query) {
      await assertPermission(user, "read");

      const requestsCrossUserScope = query.scope === "all" || query.userId !== undefined;
      if (requestsCrossUserScope) {
        await assertPermission(user, "read:any");
      }

      const targetUserId = query.userId !== undefined
        ? query.userId
        : query.scope === "all"
          ? undefined
          : user.id;

      return deps.fileRepository.list({
        userId: targetUserId,
        status: "ready",
        cursor: query.cursor,
        limit: query.limit,
      });
    },

    async uploadMultipart(user, file) {
      await assertPermission(user, "create");

      const mimeType = normalizeMimeType(file.type);
      if (!isAllowedMimeType(mimeType)) {
        throw new ValidationError("Unsupported file MIME type", { code: "INVALID_MIME_TYPE" });
      }

      if (file.size === 0) {
        throw new ValidationError("File must not be empty", { code: "EMPTY_FILE" });
      }

      if (file.size > deps.env.STORAGE_MAX_FILE_SIZE_BYTES) {
        throw new PayloadTooLargeError("File exceeds maximum upload size");
      }

      const bytes = new Uint8Array(await file.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw new ValidationError("File must not be empty", { code: "EMPTY_FILE" });
      }
      if (bytes.byteLength > deps.env.STORAGE_MAX_FILE_SIZE_BYTES) {
        throw new PayloadTooLargeError("File exceeds maximum upload size");
      }

      if (!validateMagicBytes(bytes, mimeType)) {
        throw new ValidationError("File contents do not match declared MIME type", {
          code: "INVALID_FILE_CONTENT",
        });
      }

      const id = crypto.randomUUID();
      const key = `files/${user.id}/${id}`;
      const originalName = sanitizeOriginalName(file.name);
      const checksumSha256 = createHash("sha256").update(bytes).digest("hex");

      await deps.storage.put(key, bytes, {
        contentType: mimeType,
        contentLength: bytes.byteLength,
      });

      try {
        return await deps.fileRepository.create({
          id,
          userId: user.id,
          key,
          originalName,
          mimeType,
          sizeBytes: bytes.byteLength,
          checksumSha256,
          status: "ready",
          expiresAt: null,
        });
      }
      catch (err) {
        await deleteObjectBestEffort(key);
        throw err;
      }
    },

    async createPresignedUpload(user, input) {
      await assertPermission(user, "create");

      const mimeType = normalizeMimeType(input.mimeType);
      if (!isAllowedMimeType(mimeType)) {
        throw new ValidationError("Unsupported file MIME type", { code: "INVALID_MIME_TYPE" });
      }

      if (input.sizeBytes > deps.env.STORAGE_PRESIGN_MAX_FILE_SIZE_BYTES) {
        throw new PayloadTooLargeError("File exceeds maximum presigned upload size");
      }

      const id = crypto.randomUUID();
      const key = `files/${user.id}/${id}`;
      const originalName = sanitizeOriginalName(input.originalName);
      const expiresInSeconds = deps.env.STORAGE_PRESIGN_EXPIRES_SECONDS;
      const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

      const uploadUrl = await deps.storage.getSignedPutUrl(key, {
        contentType: mimeType,
        contentLength: input.sizeBytes,
        expiresInSeconds,
      });

      const file = await deps.fileRepository.create({
        id,
        userId: user.id,
        key,
        originalName,
        mimeType,
        sizeBytes: input.sizeBytes,
        checksumSha256: null,
        status: "pending",
        expiresAt,
      });

      return { file, uploadUrl };
    },

    async completeUpload(user, id) {
      await assertPermission(user, "create");

      const existing = await deps.fileRepository.findById(id, { userId: user.id });
      if (!existing) {
        throw new NotFoundError("File not found");
      }

      if (existing.status === "ready") {
        return existing;
      }

      if (existing.expiresAt !== null && existing.expiresAt.getTime() <= Date.now()) {
        throw new ConflictError("Presigned upload has expired", { code: "UPLOAD_EXPIRED" });
      }

      const head = await deps.storage.head(existing.key);
      if (!head) {
        throw new ConflictError("Uploaded object not found in storage", { code: "OBJECT_NOT_FOUND" });
      }

      if (head.size === 0) {
        await deleteObjectBestEffort(existing.key);
        throw new ValidationError("File must not be empty", { code: "EMPTY_FILE" });
      }

      if (head.size > deps.env.STORAGE_PRESIGN_MAX_FILE_SIZE_BYTES) {
        await deleteObjectBestEffort(existing.key);
        throw new PayloadTooLargeError("File exceeds maximum presigned upload size");
      }

      const stream = await deps.storage.get(existing.key, {
        range: { start: 0, end: MAGIC_BYTE_READ_LIMIT - 1 },
      });
      if (!stream) {
        throw new ConflictError("Uploaded object not found in storage", { code: "OBJECT_NOT_FOUND" });
      }

      const headerBytes = await readStreamUpTo(stream, MAGIC_BYTE_READ_LIMIT);
      const isTruncated = head.size > headerBytes.byteLength;
      if (!validateMagicBytes(headerBytes, existing.mimeType, { truncated: isTruncated })) {
        await deleteObjectBestEffort(existing.key);
        throw new ValidationError("File contents do not match declared MIME type", {
          code: "INVALID_FILE_CONTENT",
        });
      }

      const updated = await deps.fileRepository.update(
        existing.id,
        {
          status: "ready",
          expiresAt: null,
          sizeBytes: head.size,
        },
        { userId: user.id },
      );

      if (!updated) {
        throw new NotFoundError("File not found");
      }

      return updated;
    },

    async downloadFile(user, id) {
      const record = await findReadyFileForRead(user, id);
      const stream = await deps.storage.get(record.key);
      if (!stream) {
        throw new NotFoundError("File object not found in storage");
      }

      return {
        file: record,
        stream,
        contentDisposition: buildAttachmentDisposition(record.originalName),
      };
    },

    async getDownloadUrl(user, id) {
      const record = await findReadyFileForRead(user, id);
      const expiresInSeconds = deps.env.STORAGE_PRESIGN_EXPIRES_SECONDS;
      const url = await deps.storage.getSignedGetUrl(record.key, {
        expiresInSeconds,
        responseContentType: record.mimeType,
        responseContentDisposition: buildAttachmentDisposition(record.originalName),
      });

      return { url, expiresInSeconds };
    },

    async deleteFile(user, id) {
      await assertPermission(user, "delete");
      const scope = await resolveScope(user, "delete:any");
      const existing = await deps.fileRepository.findById(id, scope);
      if (!existing) {
        throw new NotFoundError("File not found");
      }

      const deleted = await deps.fileRepository.delete(id, scope);
      if (!deleted) {
        throw new NotFoundError("File not found");
      }

      await deleteObjectBestEffort(existing.key);
    },
  };
}
