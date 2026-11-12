import { BadRequestError, ConflictError, ValidationError } from "@/core/errors";

interface DbErrorShape {
  code?: unknown;
  extendedCode?: unknown;
  message?: unknown;
  cause?: unknown;
}

function extractCodes(err: unknown): { codes: Set<string>; messages: string[] } {
  const codes = new Set<string>();
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;

  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const obj = current as DbErrorShape;
    if (typeof obj.code === "string") {
      codes.add(obj.code);
    }
    if (typeof obj.extendedCode === "string") {
      codes.add(obj.extendedCode);
    }
    if (typeof obj.message === "string") {
      messages.push(obj.message);
    }
    current = obj.cause;
  }

  return { codes, messages };
}

export function normalizeDbError(err: unknown): unknown {
  const { codes, messages } = extractCodes(err);
  const combinedMessage = messages.join(" ");

  if (
    codes.has("SQLITE_CONSTRAINT_UNIQUE")
    || codes.has("SQLITE_CONSTRAINT_PRIMARYKEY")
    || codes.has("23505")
    || (codes.has("SQLITE_CONSTRAINT") && combinedMessage.includes("UNIQUE constraint failed"))
  ) {
    return new ConflictError("Resource already exists", { cause: err });
  }

  if (
    codes.has("SQLITE_CONSTRAINT_FOREIGNKEY")
    || codes.has("23503")
    || (codes.has("SQLITE_CONSTRAINT") && combinedMessage.includes("FOREIGN KEY constraint failed"))
  ) {
    return new BadRequestError("Referenced resource does not exist", {
      code: "FOREIGN_KEY_VIOLATION",
      cause: err,
    });
  }

  if (
    codes.has("SQLITE_CONSTRAINT_NOTNULL")
    || codes.has("SQLITE_CONSTRAINT_CHECK")
    || codes.has("23502")
    || codes.has("23514")
    || (codes.has("SQLITE_CONSTRAINT")
      && (combinedMessage.includes("NOT NULL constraint failed")
        || combinedMessage.includes("CHECK constraint failed")))
  ) {
    return new ValidationError("Database constraint validation failed", { cause: err });
  }

  if (codes.has("SQLITE_CONSTRAINT")) {
    return new ConflictError("Database constraint violated", { cause: err });
  }

  return err;
}
