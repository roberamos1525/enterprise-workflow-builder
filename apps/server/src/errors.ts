import { EngineError } from "@ewb/engine";
import { z } from "zod";

/** Base class for errors that map to an HTTP status and a stable error code. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, "BAD_REQUEST", message, details);
export const validationFailed = (message: string, details?: unknown) => new AppError(422, "VALIDATION_FAILED", message, details);
export const unauthorized = (message = "authentication required") => new AppError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "insufficient permissions") => new AppError(403, "FORBIDDEN", message);
export const notFound = (what: string) => new AppError(404, "NOT_FOUND", `${what} not found`);
export const conflict = (message: string, details?: unknown) => new AppError(409, "CONFLICT", message, details);
export const tooLarge = (limit: number) => new AppError(413, "PAYLOAD_TOO_LARGE", `request body exceeds ${limit} bytes`);
export const rateLimited = (retryAfterSeconds: number) =>
  new AppError(429, "RATE_LIMITED", "too many requests", { retryAfterSeconds });

const ENGINE_STATUS: Record<string, number> = {
  NOT_FOUND: 404,
  NOT_PUBLISHED: 409,
  NOT_WAITING: 409,
  ALREADY_FINISHED: 409,
  INVALID_INPUT: 422,
  INVALID_DEFINITION: 422,
  MAX_DEPTH: 422,
  SHUTDOWN: 503,
};

export interface ErrorEnvelope {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}

/** Normalises any thrown value into an HTTP status and the standard error envelope. */
export function toErrorResponse(err: unknown, requestId?: string): { status: number; body: ErrorEnvelope } {
  const envelope = (status: number, code: string, message: string, details?: unknown) => ({
    status,
    body: { error: { code, message, ...(details !== undefined ? { details } : {}), ...(requestId ? { requestId } : {}) } },
  });
  if (err instanceof AppError) return envelope(err.status, err.code, err.message, err.details);
  if (err instanceof z.ZodError) {
    const details = err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return envelope(400, "BAD_REQUEST", "request validation failed", details);
  }
  if (err instanceof EngineError) return envelope(ENGINE_STATUS[err.code] ?? 400, err.code, err.message);
  return envelope(500, "INTERNAL", "internal server error");
}
