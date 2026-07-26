import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../errors/app-error";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}`, code: "ROUTE_NOT_FOUND" });
}

/** Postgrest/Supabase errors surface as plain objects with message/code/details/hint, not Error instances. */
function isPostgrestLikeError(err: unknown): err is { message: string; code?: string; details?: string; hint?: string } {
  return typeof err === "object" && err !== null && "message" in err && typeof err.message === "string";
}

// Express identifies error middleware by arity (4 params) -- `_next` must stay declared even though it's never called.
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    req.log.warn({ err }, "Validation failed");
    res.status(400).json({ error: "Invalid input", code: "VALIDATION_ERROR", details: err.flatten() });
    return;
  }

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      // `cause` is the original error a repository/provider caught and wrapped
      // (see InternalError) -- logged explicitly so a DB/infra failure's real
      // root cause is diagnosable, not just the generic wrapper message.
      req.log.error({ err, cause: err.cause }, "Request failed with a 5xx AppError");
    } else {
      req.log.warn({ err: { message: err.message, code: err.code } }, "Request rejected");
    }
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
    return;
  }

  if (isPostgrestLikeError(err)) {
    req.log.error({ err }, "Database error");
    res.status(500).json({ error: "A database error occurred", code: "DATABASE_ERROR" });
    return;
  }

  req.log.error({ err }, "Unhandled error");
  res.status(500).json({ error: "Internal server error", code: "INTERNAL" });
}
