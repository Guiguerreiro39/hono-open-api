import type { MemoryQueueAdapter } from "@/infra/queue";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";

import { AUTH_SECURITY } from "@/core/openapi";
import { encodeCursor } from "@/core/pagination";
import { files as filesTable } from "@/infra/db/schema";
import { filesPrunePendingJob } from "@/modules/files/files.jobs";
import { createTestApp } from "../../../tests/helpers/test-app";

function collectTsFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTsFiles(fullPath));
    }
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

const VALID_PNG_BYTES = new Uint8Array([
  0x89,
  0x50,
  0x4E,
  0x47,
  0x0D,
  0x0A,
  0x1A,
  0x0A,
  0x00,
  0x00,
  0x00,
  0x0D,
  0x49,
  0x48,
  0x44,
  0x52,
]);

const VALID_JPEG_BYTES = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46]);
const VALID_GIF_BYTES = new TextEncoder().encode("GIF89a\x01\x00\x01\x00");
const VALID_WEBP_BYTES = new Uint8Array([
  0x52,
  0x49,
  0x46,
  0x46,
  0x24,
  0x00,
  0x00,
  0x00,
  0x57,
  0x45,
  0x42,
  0x50,
  0x56,
  0x50,
  0x38,
  0x20,
]);
const VALID_PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");

describe("files feature module (/api/v1/files)", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()?.();
    }
  });

  it("keeps src/modules/files free of drizzle-orm, drizzle-zod, @aws-sdk/*, and infra imports", () => {
    const filesDir = path.join(process.cwd(), "src/modules/files");
    const files = collectTsFiles(filesDir);

    expect(files.length).toBeGreaterThan(0);
    for (const filePath of files) {
      const source = readFileSync(filePath, "utf8");
      expect(source).not.toMatch(/\bdrizzle-orm\b/);
      expect(source).not.toMatch(/\bdrizzle-zod\b/);
      expect(source).not.toMatch(/@aws-sdk\//);
      expect(source).not.toMatch(/@\/infra\//);
    }
  });

  it("validates multipart POST /api/v1/files with OpenAPI binary schema, MIME allowlist, magic bytes, and name sanitization", async () => {
    const ctx = await createTestApp({ STORAGE_MAX_FILE_SIZE_BYTES: 1024 });
    cleanups.push(ctx.cleanup);

    const user = await ctx.seedUser();
    const banned = await ctx.seedBannedUser();

    // OpenAPI /doc exposes multipart binary schema and AUTH_SECURITY
    const docRes = await ctx.app.request("/doc");
    expect(docRes.status).toBe(200);
    const doc = await docRes.json() as {
      paths?: Record<string, Record<string, {
        security?: unknown;
        requestBody?: { content?: Record<string, { schema?: { properties?: Record<string, unknown> } }> };
      }>>;
    };
    const uploadOp = doc.paths?.["/api/v1/files"]?.post;
    expect(uploadOp?.security).toEqual(AUTH_SECURITY);
    expect(uploadOp?.requestBody?.content?.["multipart/form-data"]?.schema?.properties?.file).toEqual({
      type: "string",
      format: "binary",
    });

    // Unauthenticated -> 401; Banned -> 403
    const validFile = new File([VALID_PNG_BYTES], "../../nested/avatar.png", { type: "image/png" });
    expect((await ctx.client.api.v1.files.$post({ form: { file: validFile } })).status).toBe(401);
    expect((await ctx.client.api.v1.files.$post({ form: { file: validFile } }, { headers: banned.headers })).status).toBe(403);

    // Non-File string field -> 422
    const badForm = new FormData();
    badForm.set("file", "not-a-file");
    const nonFileRes = await ctx.app.request("/api/v1/files", {
      method: "POST",
      headers: user.headers,
      body: badForm,
    });
    expect(nonFileRes.status).toBe(422);

    // Disallowed MIME types (SVG, HTML, octet-stream) -> 422
    for (const [mime, content, name] of [
      ["image/svg+xml", "<svg xmlns=\"http://www.w3.org/2000/svg\"/>", "xss.svg"],
      ["text/html", "<html><script>alert(1)</script></html>", "xss.html"],
      ["application/octet-stream", "binary", "blob.bin"],
    ] as const) {
      const badMimeFile = new File([content], name, { type: mime });
      const res = await ctx.client.api.v1.files.$post({ form: { file: badMimeFile } }, { headers: user.headers });
      expect(res.status).toBe(422);
    }

    // Spoofed magic bytes -> 422
    const spoofedCases = [
      new File(["plain-text-not-png"], "fake.png", { type: "image/png" }),
      new File([VALID_JPEG_BYTES], "fake-jpeg.png", { type: "image/png" }),
      new File([VALID_PNG_BYTES], "fake-png.jpg", { type: "image/jpeg" }),
      new File([VALID_PNG_BYTES], "fake-png.webp", { type: "image/webp" }),
      new File([VALID_PNG_BYTES], "fake-png.gif", { type: "image/gif" }),
      new File(["not a pdf"], "fake.pdf", { type: "application/pdf" }),
      new File([VALID_PNG_BYTES], "binary-as-text.txt", { type: "text/plain" }),
      new File(["<html>not json</html>"], "fake.json", { type: "application/json" }),
    ];
    for (const spoofed of spoofedCases) {
      const res = await ctx.client.api.v1.files.$post({ form: { file: spoofed } }, { headers: user.headers });
      expect(res.status).toBe(422);
    }

    // Empty file -> 422
    const emptyFile = new File([], "empty.txt", { type: "text/plain" });
    expect((await ctx.client.api.v1.files.$post({ form: { file: emptyFile } }, { headers: user.headers })).status).toBe(422);

    // Exceeds STORAGE_MAX_FILE_SIZE_BYTES -> 413
    const oversizedFile = new File([new Uint8Array(1025).fill(0x61)], "big.txt", { type: "text/plain" });
    expect((await ctx.client.api.v1.files.$post({ form: { file: oversizedFile } }, { headers: user.headers })).status).toBe(413);

    // Valid uploads across supported allowlist types + filename sanitization
    const allowedSamples = [
      { bytes: VALID_PNG_BYTES, name: "../../nested/photo.png", expectedName: "photo.png", mime: "image/png" },
      { bytes: VALID_JPEG_BYTES, name: "C:\\fakepath\\pic.jpg", expectedName: "pic.jpg", mime: "image/jpeg" },
      { bytes: VALID_GIF_BYTES, name: "anim.gif", expectedName: "anim.gif", mime: "image/gif" },
      { bytes: VALID_WEBP_BYTES, name: "img.webp", expectedName: "img.webp", mime: "image/webp" },
      { bytes: VALID_PDF_BYTES, name: "doc.pdf", expectedName: "doc.pdf", mime: "application/pdf" },
      { bytes: new TextEncoder().encode("hello,world\n1,2\n"), name: "data.csv", expectedName: "data.csv", mime: "text/csv" },
      { bytes: new TextEncoder().encode("{\"ok\":true}"), name: "meta.json", expectedName: "meta.json", mime: "application/json" },
      { bytes: new TextEncoder().encode("hello world"), name: "note.txt", expectedName: "note.txt", mime: "text/plain" },
    ];

    for (const sample of allowedSamples) {
      const f = new File([sample.bytes], sample.name, { type: sample.mime });
      const res = await ctx.client.api.v1.files.$post({ form: { file: f } }, { headers: user.headers });
      expect(res.status).toBe(201);
      if (res.status === 201) {
        const body = await res.json();
        expect(body.originalName).toBe(sample.expectedName);
        expect(body.mimeType).toBe(sample.mime);
        expect(body.sizeBytes).toBe(sample.bytes.byteLength);
        expect(body.status).toBe("ready");
        expect(body.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(body.expiresAt).toBeNull();
        expect(body.userId).toBe(user.user.id);
      }
    }
  });

  it("handles presigned direct upload lifecycle, 4096-byte range magic check, idempotency, expiry, and missing objects", async () => {
    const ctx = await createTestApp({
      STORAGE_PRESIGN_MAX_FILE_SIZE_BYTES: 8192,
      STORAGE_PRESIGN_EXPIRES_SECONDS: 300,
    });
    cleanups.push(ctx.cleanup);

    const alice = await ctx.seedUser();
    const bob = await ctx.seedUser();

    // Disallowed MIME & oversized presign requests
    expect((await ctx.client.api.v1.files.presign.$post({
      json: { originalName: "bad.svg", mimeType: "image/svg+xml", sizeBytes: 100 },
    }, { headers: alice.headers })).status).toBe(422);

    expect((await ctx.client.api.v1.files.presign.$post({
      json: { originalName: "huge.png", mimeType: "image/png", sizeBytes: 8193 },
    }, { headers: alice.headers })).status).toBe(413);

    // 1) Happy path with > 4096-byte UTF-8 JSON (exercises 4096-byte range read truncation)
    const largeText = `{"message":"${"é".repeat(2500)}"}`;
    const largeBytes = new TextEncoder().encode(largeText);
    expect(largeBytes.byteLength).toBeGreaterThan(4096);

    const presignRes = await ctx.client.api.v1.files.presign.$post({
      json: {
        originalName: "../dir/payload.json",
        mimeType: "application/json",
        sizeBytes: largeBytes.byteLength,
      },
    }, { headers: alice.headers });
    expect(presignRes.status).toBe(201);
    if (presignRes.status !== 201) {
      throw new Error(`Expected 201, got ${presignRes.status}`);
    }
    const { file: pendingFile, uploadUrl } = await presignRes.json();
    expect(pendingFile.status).toBe("pending");
    expect(pendingFile.originalName).toBe("payload.json");
    expect(pendingFile.expiresAt).not.toBeNull();

    // Completing before uploading blob -> 409
    const missingBlobComplete = await ctx.client.api.v1.files[":id"].complete.$post({
      param: { id: pendingFile.id },
    }, { headers: alice.headers });
    expect(missingBlobComplete.status).toBe(409);

    // Foreign user cannot complete -> 404
    const foreignComplete = await ctx.client.api.v1.files[":id"].complete.$post({
      param: { id: pendingFile.id },
    }, { headers: bob.headers });
    expect(foreignComplete.status).toBe(404);

    // PUT via signed /_storage/* URL -> 200
    const putRes = await ctx.app.request(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: largeBytes,
    });
    expect(putRes.status).toBe(200);

    // Complete -> 200 ready
    const completeRes = await ctx.client.api.v1.files[":id"].complete.$post({
      param: { id: pendingFile.id },
    }, { headers: alice.headers });
    expect(completeRes.status).toBe(200);
    if (completeRes.status === 200) {
      const completed = await completeRes.json();
      expect(completed.status).toBe("ready");
      expect(completed.expiresAt).toBeNull();
      expect(completed.sizeBytes).toBe(largeBytes.byteLength);
    }

    // Repeat /complete is idempotent -> 200
    const repeatComplete = await ctx.client.api.v1.files[":id"].complete.$post({
      param: { id: pendingFile.id },
    }, { headers: alice.headers });
    expect(repeatComplete.status).toBe(200);
    if (repeatComplete.status === 200) {
      expect((await repeatComplete.json()).status).toBe("ready");
    }

    // 2) Spoofed magic bytes on /complete -> deletes object and returns 422
    const spoofBytes = new TextEncoder().encode("not-actually-a-png");
    const spoofPresign = await ctx.client.api.v1.files.presign.$post({
      json: { originalName: "spoof.png", mimeType: "image/png", sizeBytes: spoofBytes.byteLength },
    }, { headers: alice.headers });
    expect(spoofPresign.status).toBe(201);
    if (spoofPresign.status === 201) {
      const { file: spoofPending, uploadUrl: spoofUploadUrl } = await spoofPresign.json();
      const spoofPut = await ctx.app.request(spoofUploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: spoofBytes,
      });
      expect(spoofPut.status).toBe(200);

      const spoofRecord = await ctx.container.fileRepository.findById(spoofPending.id);
      expect(await ctx.container.storage.head(spoofRecord!.key)).not.toBeNull();

      const spoofComplete = await ctx.client.api.v1.files[":id"].complete.$post({
        param: { id: spoofPending.id },
      }, { headers: alice.headers });
      expect(spoofComplete.status).toBe(422);
      expect(await ctx.container.storage.head(spoofRecord!.key)).toBeNull();
    }

    // 3) Expired pending upload -> 409
    const expBytes = VALID_PNG_BYTES;
    const expPresign = await ctx.client.api.v1.files.presign.$post({
      json: { originalName: "expired.png", mimeType: "image/png", sizeBytes: expBytes.byteLength },
    }, { headers: alice.headers });
    expect(expPresign.status).toBe(201);
    if (expPresign.status === 201) {
      const { file: expPending, uploadUrl: expUploadUrl } = await expPresign.json();
      await ctx.app.request(expUploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: expBytes,
      });
      await ctx.container.db
        .update(filesTable)
        .set({ expiresAt: new Date(Date.now() - 10_000) })
        .where(eq(filesTable.id, expPending.id));

      const expiredComplete = await ctx.client.api.v1.files[":id"].complete.$post({
        param: { id: expPending.id },
      }, { headers: alice.headers });
      expect(expiredComplete.status).toBe(409);
    }
  });

  it("lists ready files with cursor pagination, RBAC scoping, streaming /download headers, and signed /url", async () => {
    const ctx = await createTestApp();
    cleanups.push(ctx.cleanup);

    const alice = await ctx.seedUser();
    const bob = await ctx.seedUser();
    const admin = await ctx.seedAdmin();

    // Seed pending file for alice (must be excluded from GET /files and return 409 on /download and /url)
    const pendingPresign = await ctx.client.api.v1.files.presign.$post({
      json: { originalName: "wip.txt", mimeType: "text/plain", sizeBytes: 5 },
    }, { headers: alice.headers });
    expect(pendingPresign.status).toBe(201);
    const pendingId = pendingPresign.status === 201 ? (await pendingPresign.json()).file.id : "";

    expect((await ctx.client.api.v1.files[":id"].download.$get({
      param: { id: pendingId },
    }, { headers: alice.headers })).status).toBe(409);
    expect((await ctx.client.api.v1.files[":id"].url.$get({
      param: { id: pendingId },
    }, { headers: alice.headers })).status).toBe(409);

    // Seed 3 ready files for alice + 1 ready file for bob
    const aliceIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const f = new File([`alice-content-${i}`], `alice-${i}.txt`, { type: "text/plain" });
      const res = await ctx.client.api.v1.files.$post({ form: { file: f } }, { headers: alice.headers });
      expect(res.status).toBe(201);
      if (res.status === 201) {
        aliceIds.push((await res.json()).id);
      }
    }

    const bobRes = await ctx.client.api.v1.files.$post({
      form: { file: new File(["bob-secret"], "bob.txt", { type: "text/plain" }) },
    }, { headers: bob.headers });
    expect(bobRes.status).toBe(201);
    const bobFileId = bobRes.status === 201 ? (await bobRes.json()).id : "";

    // Alice lists her files with pagination (pending file excluded, bob file excluded)
    const page1 = await ctx.client.api.v1.files.$get({
      query: { limit: "2" },
    }, { headers: alice.headers });
    expect(page1.status).toBe(200);
    if (page1.status === 200) {
      const b1 = await page1.json();
      expect(b1.data).toHaveLength(2);
      expect(b1.meta.hasMore).toBe(true);
      expect(b1.meta.nextCursor).toBeTruthy();

      const page2 = await ctx.client.api.v1.files.$get({
        query: { limit: "2", cursor: b1.meta.nextCursor ?? undefined },
      }, { headers: alice.headers });
      expect(page2.status).toBe(200);
      if (page2.status === 200) {
        const b2 = await page2.json();
        expect(b2.data).toHaveLength(1);
        expect(b2.meta).toEqual({ hasMore: false, nextCursor: null });
        const allIds = [...b1.data, ...b2.data].map(f => f.id);
        expect(allIds).not.toContain(pendingId);
        expect(allIds).not.toContain(bobFileId);
        expect(allIds.slice().sort()).toEqual(aliceIds.slice().sort());
      }
    }

    // Invalid cursor -> 400
    const badCursor = await ctx.client.api.v1.files.$get({
      query: { cursor: "bad!cursor" },
    }, { headers: alice.headers });
    expect(badCursor.status).toBe(400);

    // Out-of-range integer timestamp cursors -> 400 INVALID_CURSOR
    for (const outOfRange of [Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER]) {
      const oorRes = await ctx.client.api.v1.files.$get({
        query: { cursor: encodeCursor({ v: outOfRange, id: crypto.randomUUID() }) },
      }, { headers: alice.headers });
      expect(oorRes.status).toBe(400);
      expect(await oorRes.json()).toMatchObject({
        error: { code: "INVALID_CURSOR" },
      });
    }

    // Non-admin cross-user query -> 403; foreign IDs -> 404
    expect((await ctx.client.api.v1.files.$get({ query: { scope: "all" } }, { headers: alice.headers })).status).toBe(403);
    expect((await ctx.client.api.v1.files.$get({ query: { userId: bob.user.id } }, { headers: alice.headers })).status).toBe(403);
    expect((await ctx.client.api.v1.files[":id"].download.$get({ param: { id: bobFileId } }, { headers: alice.headers })).status).toBe(404);
    expect((await ctx.client.api.v1.files[":id"].url.$get({ param: { id: bobFileId } }, { headers: alice.headers })).status).toBe(404);

    // Admin cross-user listing and access via file:read:any
    const adminAll = await ctx.client.api.v1.files.$get({ query: { scope: "all" } }, { headers: admin.headers });
    expect(adminAll.status).toBe(200);
    if (adminAll.status === 200) {
      const body = await adminAll.json();
      expect(body.data.map(f => f.id).sort()).toEqual([...aliceIds, bobFileId].sort());
    }

    const adminBobOnly = await ctx.client.api.v1.files.$get({ query: { userId: bob.user.id } }, { headers: admin.headers });
    expect(adminBobOnly.status).toBe(200);
    if (adminBobOnly.status === 200) {
      expect((await adminBobOnly.json()).data.map(f => f.id)).toEqual([bobFileId]);
    }

    // Streaming download headers & body
    const dlRes = await ctx.client.api.v1.files[":id"].download.$get({
      param: { id: bobFileId },
    }, { headers: admin.headers });
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get("content-type")).toBe("text/plain");
    expect(dlRes.headers.get("content-disposition")).toBe("attachment; filename=\"bob.txt\"");
    expect(dlRes.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dlRes.headers.get("cache-control")).toBe("private, no-store");
    expect(await dlRes.text()).toBe("bob-secret");

    // Signed URL endpoint -> fetches via /_storage/*
    const urlRes = await ctx.client.api.v1.files[":id"].url.$get({
      param: { id: bobFileId },
    }, { headers: bob.headers });
    expect(urlRes.status).toBe(200);
    if (urlRes.status === 200) {
      const { url, expiresInSeconds } = await urlRes.json();
      expect(expiresInSeconds).toBe(ctx.env.STORAGE_PRESIGN_EXPIRES_SECONDS);
      const signedFetch = await ctx.app.request(url);
      expect(signedFetch.status).toBe(200);
      expect(signedFetch.headers.get("content-disposition")).toBe("attachment; filename=\"bob.txt\"");
      expect(await signedFetch.text()).toBe("bob-secret");
    }
  });

  it("uploads, downloads, and serves signed URLs for non-ASCII filenames (> U+00FF) with valid RFC 5987 Content-Disposition", async () => {
    const ctx = await createTestApp();
    cleanups.push(ctx.cleanup);

    const user = await ctx.seedUser();
    const unicodeName = "日本語🚀.png";
    const uploadRes = await ctx.client.api.v1.files.$post({
      form: { file: new File([VALID_PNG_BYTES], unicodeName, { type: "image/png" }) },
    }, { headers: user.headers });
    expect(uploadRes.status).toBe(201);
    if (uploadRes.status !== 201) {
      throw new Error(`Expected 201, got ${uploadRes.status}`);
    }
    const uploaded = await uploadRes.json();
    expect(uploaded.originalName).toBe(unicodeName);

    const expectedDisposition = `attachment; filename="____.png"; filename*=UTF-8''${encodeURIComponent(unicodeName)}`;

    const dlRes = await ctx.client.api.v1.files[":id"].download.$get({
      param: { id: uploaded.id },
    }, { headers: user.headers });
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get("content-disposition")).toBe(expectedDisposition);
    expect(new Uint8Array(await dlRes.arrayBuffer())).toEqual(VALID_PNG_BYTES);

    const urlRes = await ctx.client.api.v1.files[":id"].url.$get({
      param: { id: uploaded.id },
    }, { headers: user.headers });
    expect(urlRes.status).toBe(200);
    if (urlRes.status !== 200) {
      throw new Error(`Expected 200, got ${urlRes.status}`);
    }
    const { url } = await urlRes.json();
    const signedFetch = await ctx.app.request(url);
    expect(signedFetch.status).toBe(200);
    expect(signedFetch.headers.get("content-disposition")).toBe(expectedDisposition);
    expect(new Uint8Array(await signedFetch.arrayBuffer())).toEqual(VALID_PNG_BYTES);

    // Non-ASCII filename with RFC 5987 reserved characters (', (, )) percent-encodes them properly
    const rfcName = "résumé (v1) 'final'.png";
    const rfcRes = await ctx.client.api.v1.files.$post({
      form: { file: new File([VALID_PNG_BYTES], rfcName, { type: "image/png" }) },
    }, { headers: user.headers });
    expect(rfcRes.status).toBe(201);
    if (rfcRes.status === 201) {
      const rfcFile = await rfcRes.json();
      const rfcDl = await ctx.client.api.v1.files[":id"].download.$get({
        param: { id: rfcFile.id },
      }, { headers: user.headers });
      expect(rfcDl.status).toBe(200);
      expect(rfcDl.headers.get("content-disposition")).toBe(
        "attachment; filename=\"r_sum_ (v1) 'final'.png\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%28v1%29%20%27final%27.png",
      );
    }
  });

  it("performs DB-first DELETE with files.deleteObject retry on storage failure and admin delete:any", async () => {
    const ctx = await createTestApp();
    cleanups.push(ctx.cleanup);

    const alice = await ctx.seedUser();
    const bob = await ctx.seedUser();
    const admin = await ctx.seedAdmin();

    // Create two files for alice
    const res1 = await ctx.client.api.v1.files.$post({
      form: { file: new File(["file-1"], "one.txt", { type: "text/plain" }) },
    }, { headers: alice.headers });
    expect(res1.status).toBe(201);
    const file1Id = res1.status === 201 ? (await res1.json()).id : "";
    const file1Rec = await ctx.container.fileRepository.findById(file1Id);

    const res2 = await ctx.client.api.v1.files.$post({
      form: { file: new File(["file-2"], "two.txt", { type: "text/plain" }) },
    }, { headers: alice.headers });
    expect(res2.status).toBe(201);
    const file2Id = res2.status === 201 ? (await res2.json()).id : "";
    const file2Rec = await ctx.container.fileRepository.findById(file2Id);

    // Foreign user cannot delete -> 404
    expect((await ctx.client.api.v1.files[":id"].$delete({
      param: { id: file1Id },
    }, { headers: bob.headers })).status).toBe(404);
    expect(await ctx.container.fileRepository.findById(file1Id)).not.toBeNull();

    // Normal delete removes both DB row and storage object
    expect((await ctx.client.api.v1.files[":id"].$delete({
      param: { id: file1Id },
    }, { headers: alice.headers })).status).toBe(204);
    expect(await ctx.container.fileRepository.findById(file1Id)).toBeNull();
    expect(await ctx.container.storage.head(file1Rec!.key)).toBeNull();

    // Simulate transient storage.delete error during admin delete -> DB row still deleted (204), job retries & cleans blob
    const originalDelete = ctx.container.storage.delete.bind(ctx.container.storage);
    let failNextDelete = true;
    ctx.container.storage.delete = async (key: string) => {
      if (failNextDelete) {
        failNextDelete = false;
        throw new Error("Transient storage outage");
      }
      return originalDelete(key);
    };

    const adminDel = await ctx.client.api.v1.files[":id"].$delete({
      param: { id: file2Id },
    }, { headers: admin.headers });
    expect(adminDel.status).toBe(204);
    expect(await ctx.container.fileRepository.findById(file2Id)).toBeNull();
    // Blob still exists until queue drains
    expect(await ctx.container.storage.head(file2Rec!.key)).not.toBeNull();

    const queue = ctx.container.queue as MemoryQueueAdapter;
    await queue.drain();
    expect(queue.getJobs().some(j => j.name === "files.deleteObject" && j.status === "completed")).toBe(true);
    expect(await ctx.container.storage.head(file2Rec!.key)).toBeNull();
  });

  it("prunes expired pending files and objects via files.prunePending while keeping active pending and ready files", async () => {
    const ctx = await createTestApp();
    cleanups.push(ctx.cleanup);

    const user = await ctx.seedUser();

    // 1) Expired pending file (with blob uploaded)
    const expRes = await ctx.client.api.v1.files.presign.$post({
      json: { originalName: "stale.txt", mimeType: "text/plain", sizeBytes: 5 },
    }, { headers: user.headers });
    expect(expRes.status).toBe(201);
    const expData = expRes.status === 201 ? await expRes.json() : null;
    await ctx.app.request(expData!.uploadUrl, { method: "PUT", body: "stale" });
    const expRec = await ctx.container.fileRepository.findById(expData!.file.id);
    await ctx.container.db
      .update(filesTable)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(filesTable.id, expData!.file.id));

    // 2) Non-expired pending file (with blob uploaded)
    const activeRes = await ctx.client.api.v1.files.presign.$post({
      json: { originalName: "fresh.txt", mimeType: "text/plain", sizeBytes: 5 },
    }, { headers: user.headers });
    expect(activeRes.status).toBe(201);
    const activeData = activeRes.status === 201 ? await activeRes.json() : null;
    await ctx.app.request(activeData!.uploadUrl, { method: "PUT", body: "fresh" });
    const activeRec = await ctx.container.fileRepository.findById(activeData!.file.id);

    // 3) Ready file
    const readyRes = await ctx.client.api.v1.files.$post({
      form: { file: new File(["ready"], "ready.txt", { type: "text/plain" }) },
    }, { headers: user.headers });
    expect(readyRes.status).toBe(201);
    const readyId = readyRes.status === 201 ? (await readyRes.json()).id : "";
    const readyRec = await ctx.container.fileRepository.findById(readyId);

    const queue = ctx.container.queue as MemoryQueueAdapter;
    await queue.enqueue(filesPrunePendingJob, {});
    await queue.drain();

    expect(await ctx.container.fileRepository.findById(expData!.file.id)).toBeNull();
    expect(await ctx.container.storage.head(expRec!.key)).toBeNull();

    expect(await ctx.container.fileRepository.findById(activeData!.file.id)).not.toBeNull();
    expect(await ctx.container.storage.head(activeRec!.key)).not.toBeNull();

    expect(await ctx.container.fileRepository.findById(readyId)).not.toBeNull();
    expect(await ctx.container.storage.head(readyRec!.key)).not.toBeNull();
  });

  it("enforces 10 req/min upload rate limit on /files and /files/presign and STORAGE_MAX_FILE_SIZE_BYTES + 64 KB bodyLimit", async () => {
    // Part A: upload bodyLimit > 1 MB default
    const largeLimit = 1024 * 1024 + 128 * 1024;
    const largeCtx = await createTestApp({ STORAGE_MAX_FILE_SIZE_BYTES: largeLimit });
    cleanups.push(largeCtx.cleanup);

    const largeUser = await largeCtx.seedUser();
    const over1MbBytes = new Uint8Array(1024 * 1024 + 1024).fill(0x61); // > 1 MB, < largeLimit
    const over1MbFile = new File([over1MbBytes], "big.txt", { type: "text/plain" });
    const over1MbRes = await largeCtx.client.api.v1.files.$post({
      form: { file: over1MbFile },
    }, { headers: largeUser.headers });
    expect(over1MbRes.status).toBe(201);

    const wayTooLargeBytes = new Uint8Array(largeLimit + 65 * 1024).fill(0x61); // > largeLimit + 64 KB
    const wayTooLargeFile = new File([wayTooLargeBytes], "huge.txt", { type: "text/plain" });
    const wayTooLargeRes = await largeCtx.client.api.v1.files.$post({
      form: { file: wayTooLargeFile },
    }, { headers: largeUser.headers });
    expect(wayTooLargeRes.status).toBe(413);

    // Part B: 10 req/min rate limit on POST /files and POST /files/presign
    const rlCtx = await createTestApp({ RATE_LIMIT_ENABLED: true });
    cleanups.push(rlCtx.cleanup);
    const rlUser = await rlCtx.seedUser();

    for (let i = 0; i < 10; i++) {
      const res = await rlCtx.client.api.v1.files.presign.$post({
        json: { originalName: `f-${i}.txt`, mimeType: "text/plain", sizeBytes: 4 },
      }, { headers: rlUser.headers });
      expect(res.status).toBe(201);
      expect(res.headers.get("RateLimit-Policy")).toBe("10;w=60");
    }

    const blockedPresign = await rlCtx.client.api.v1.files.presign.$post({
      json: { originalName: "blocked.txt", mimeType: "text/plain", sizeBytes: 4 },
    }, { headers: rlUser.headers });
    expect(blockedPresign.status).toBe(429);

    const blockedMultipart = await rlCtx.client.api.v1.files.$post({
      form: { file: new File(["abcd"], "blocked.txt", { type: "text/plain" }) },
    }, { headers: rlUser.headers });
    expect(blockedMultipart.status).toBe(429);
  });
});
