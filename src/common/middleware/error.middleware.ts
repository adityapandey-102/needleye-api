import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../errors/app-error";
import { ERROR_CODES } from "../errors/error-codes";
import { describeDbError } from "../database/db-logging";
import { env } from "../../config/env";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({
    error: `Not found: ${req.method} ${req.path}`,
    code: ERROR_CODES.ROUTE_NOT_FOUND,
    requestId: typeof req.id === "string" ? req.id : undefined,
  });
}

/** Postgrest/Supabase errors surface as plain objects with message/code/details/hint, not Error instances. */
function isPostgrestLikeError(err: unknown): err is { message: string; code?: string; details?: string; hint?: string } {
  return typeof err === "object" && err !== null && "message" in err && typeof err.message === "string";
}

/**
 * The single place a thrown error becomes an HTTP response -- controllers and
 * services never log-and-rethrow, so an error is logged exactly once, here,
 * with full request context (id/method/route). The response body always
 * carries a stable `code` (clients branch on it, not the message) and the
 * `requestId`, so a user reporting "request X failed" can be traced straight
 * to its log line. Stack traces and raw causes go to the logs only, never to
 * the client; in development the stack is additionally echoed in the response
 * body to speed up local debugging.
 */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const requestId = typeof req.id === "string" ? req.id : undefined;
  // req.route is loosely typed (any); read its path defensively, falling back
  // to the concrete path. Gives the matched route pattern where available.
  const routePath = (req.route as { path?: string } | undefined)?.path;
  const logContext = { method: req.method, route: routePath ?? req.path };
  const isDev = env.NODE_ENV === "development";

  if (err instanceof ZodError) {
    req.log.warn({ ...logContext, err }, "Validation failed");
    res.status(400).json({ error: "Invalid input", code: ERROR_CODES.VALIDATION_ERROR, details: err.flatten(), requestId });
    return;
  }

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      // `cause` is the original error a repository/provider caught and wrapped
      // (see InternalError) -- logged explicitly so a DB/infra failure's real
      // root cause is diagnosable, not just the generic wrapper message. When
      // it's a DB error, log only its SAFE metadata (SQLSTATE/constraint/table);
      // the raw pg error's `detail` can contain customer row values.
      const cause = describeDbError(err.cause) ?? err.cause;
      req.log.error({ ...logContext, err, cause }, "Request failed with a 5xx AppError");
    } else {
      req.log.warn({ ...logContext, err: { message: err.message, code: err.code } }, "Request rejected");
    }
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      ...(err.details !== undefined ? { details: err.details } : {}),
      requestId,
    });
    return;
  }

  if (isPostgrestLikeError(err)) {
    // Log only safe DB metadata (no `detail`/row values).
    req.log.error({ ...logContext, db: describeDbError(err), err: { message: err.message, code: err.code } }, "Database error");
    res.status(500).json({
      error: "A database error occurred",
      code: ERROR_CODES.DATABASE_ERROR,
      requestId,
      ...(isDev && err instanceof Error ? { stack: err.stack } : {}),
    });
    return;
  }

  req.log.error({ ...logContext, err }, "Unhandled error");
  res.status(500).json({
    error: "Internal server error",
    code: ERROR_CODES.INTERNAL,
    requestId,
    ...(isDev && err instanceof Error ? { stack: err.stack } : {}),
  });
}
