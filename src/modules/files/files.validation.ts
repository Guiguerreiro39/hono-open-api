export const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/json",
] as const;

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

const ALLOWED_MIME_SET = new Set<string>(ALLOWED_MIME_TYPES);

export const MAGIC_BYTE_READ_LIMIT = 4096;

export function normalizeMimeType(mimeType: string): string {
  return (mimeType.split(";")[0] ?? "").trim().toLowerCase();
}

export function isAllowedMimeType(mimeType: string): mimeType is AllowedMimeType {
  return ALLOWED_MIME_SET.has(normalizeMimeType(mimeType));
}

export function sanitizeOriginalName(rawName: string): string {
  const lastSlash = Math.max(rawName.lastIndexOf("/"), rawName.lastIndexOf("\\"));
  let base = lastSlash >= 0 ? rawName.slice(lastSlash + 1) : rawName;

  // Strip ASCII control chars (0x00-0x1F, 0x7F), quotes, and filesystem-unsafe punctuation.
  // eslint-disable-next-line no-control-regex
  base = base.replace(/[\x00-\x1F\x7F"<>|:*?]/g, "").trim();
  base = base.replace(/\s+/g, " ");

  if (!base || base === "." || base === "..") {
    return "file";
  }

  if (base.length > 255) {
    base = base.slice(0, 255);
  }

  return base;
}

const PRINTABLE_ASCII_REGEX = /^[\x20-\x7E]+$/;

function encodeRfc5987(value: string): string {
  const wellFormed = typeof value.toWellFormed === "function" ? value.toWellFormed() : value;
  return encodeURIComponent(wellFormed).replace(
    /['()*]/g,
    char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function buildAttachmentDisposition(originalName: string): string {
  const safeName = sanitizeOriginalName(originalName);
  if (PRINTABLE_ASCII_REGEX.test(safeName)) {
    return `attachment; filename="${safeName}"`;
  }

  const asciiFallback = safeName.replace(/[^\x20-\x7E]/gu, "_").trim();
  const fallback = !asciiFallback || asciiFallback === "." || asciiFallback === ".."
    ? "file"
    : asciiFallback;

  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(safeName)}`;
}

function hasPrefix(bytes: Uint8Array, expected: readonly number[]): boolean {
  if (bytes.byteLength < expected.length) {
    return false;
  }
  for (let i = 0; i < expected.length; i++) {
    if (bytes[i] !== expected[i]) {
      return false;
    }
  }
  return true;
}

function hasDisallowedControlBytes(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0x09 || byte === 0x0A || byte === 0x0D) {
      continue;
    }
    if (byte < 0x20 || byte === 0x7F) {
      return true;
    }
  }
  return false;
}

function trimTrailingIncompleteUtf8(bytes: Uint8Array): Uint8Array {
  let end = bytes.byteLength;
  let continuations = 0;
  while (end > 0 && continuations < 3 && (bytes[end - 1]! & 0xC0) === 0x80) {
    end -= 1;
    continuations += 1;
  }
  if (end > 0) {
    const lead = bytes[end - 1]!;
    let expectedLen = 1;
    if ((lead & 0xE0) === 0xC0) {
      expectedLen = 2;
    }
    else if ((lead & 0xF0) === 0xE0) {
      expectedLen = 3;
    }
    else if ((lead & 0xF8) === 0xF0) {
      expectedLen = 4;
    }
    const availableLen = bytes.byteLength - (end - 1);
    if (expectedLen > 1 && availableLen < expectedLen) {
      return bytes.subarray(0, end - 1);
    }
  }
  return bytes;
}

function decodeValidUtf8Text(bytes: Uint8Array, truncated: boolean): string | null {
  if (hasDisallowedControlBytes(bytes)) {
    return null;
  }
  const target = truncated ? trimTrailingIncompleteUtf8(bytes) : bytes;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(target);
  }
  catch {
    return null;
  }
}

const JSON_START_CHARS = new Set(["{", "[", "\"", "t", "f", "n", "-", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);

export function validateMagicBytes(
  bytes: Uint8Array,
  mimeType: string,
  options?: { truncated?: boolean },
): boolean {
  if (bytes.byteLength === 0) {
    return false;
  }

  const normalized = normalizeMimeType(mimeType);
  const truncated = options?.truncated ?? false;

  switch (normalized) {
    case "image/jpeg":
      return hasPrefix(bytes, [0xFF, 0xD8, 0xFF]);

    case "image/png":
      return hasPrefix(bytes, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    case "image/gif":
      return (
        hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
        || hasPrefix(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])
      );

    case "image/webp":
      return (
        bytes.byteLength >= 12
        && hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46])
        && bytes[8] === 0x57
        && bytes[9] === 0x45
        && bytes[10] === 0x42
        && bytes[11] === 0x50
      );

    case "application/pdf":
      return hasPrefix(bytes, [0x25, 0x50, 0x44, 0x46, 0x2D]);

    case "text/plain":
    case "text/csv":
      return decodeValidUtf8Text(bytes, truncated) !== null;

    case "application/json": {
      const decoded = decodeValidUtf8Text(bytes, truncated);
      if (decoded === null) {
        return false;
      }
      const trimmed = decoded.replace(/^\uFEFF/, "").trimStart();
      if (trimmed.length === 0 || !JSON_START_CHARS.has(trimmed[0]!)) {
        return false;
      }
      if (!truncated) {
        try {
          JSON.parse(trimmed);
        }
        catch {
          return false;
        }
      }
      return true;
    }

    default:
      return false;
  }
}
