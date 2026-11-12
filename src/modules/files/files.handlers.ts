import type {
  completeFileRoute,
  deleteFileRoute,
  downloadFileRoute,
  getFileUrlRoute,
  listFilesRoute,
  presignFileRoute,
  uploadFileRoute,
} from "./files.routes";
import type { FilesService } from "./files.service";
import type { AppRouteHandler } from "@/core/types";

import { formatFileDto } from "./files.service";

export function createFilesHandlers(service: FilesService) {
  const listFiles: AppRouteHandler<typeof listFilesRoute> = async (c) => {
    const user = c.get("user");
    const query = c.req.valid("query");
    const result = await service.listFiles(user, query);

    return c.json({
      data: result.data.map(formatFileDto),
      meta: result.meta,
    }, 200);
  };

  const uploadFile: AppRouteHandler<typeof uploadFileRoute> = async (c) => {
    const user = c.get("user");
    const { file } = c.req.valid("form");
    const created = await service.uploadMultipart(user, file);

    return c.json(formatFileDto(created), 201);
  };

  const presignFile: AppRouteHandler<typeof presignFileRoute> = async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const result = await service.createPresignedUpload(user, body);

    return c.json({
      file: formatFileDto(result.file),
      uploadUrl: result.uploadUrl,
    }, 201);
  };

  const completeFile: AppRouteHandler<typeof completeFileRoute> = async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const completed = await service.completeUpload(user, id);

    return c.json(formatFileDto(completed), 200);
  };

  const downloadFile: AppRouteHandler<typeof downloadFileRoute> = async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const { file, stream, contentDisposition } = await service.downloadFile(user, id);

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": file.mimeType,
        "Content-Length": String(file.sizeBytes),
        "Content-Disposition": contentDisposition,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      },
    });
  };

  const getFileUrl: AppRouteHandler<typeof getFileUrlRoute> = async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    const result = await service.getDownloadUrl(user, id);

    return c.json(result, 200);
  };

  const deleteFile: AppRouteHandler<typeof deleteFileRoute> = async (c) => {
    const user = c.get("user");
    const { id } = c.req.valid("param");
    await service.deleteFile(user, id);

    return c.body(null, 204);
  };

  return {
    listFiles,
    uploadFile,
    presignFile,
    completeFile,
    downloadFile,
    getFileUrl,
    deleteFile,
  };
}
