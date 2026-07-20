import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";
import { AppError } from "../errors/app-error";

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}`, code: "ROUTE_NOT_FOUND" });
}

/** Postgrest/Supabase errors surface as plain objects with message/code/details/hint, not Error instances. */
function isPostgrestLikeError(err: unknown): err is { message: string; code?: string; details?: string; hint?: string } {
  return typeof err === "object" && err !== null && "message" in err && typeof (err as { message: unknown }).message === "string";
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express identifies error middleware by arity (4 params)
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ZodError) {
    res.status(400).json({ error: "Invalid input", code: "VALIDATION_ERROR", details: err.flatten() });
    return;
  }

  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      console.error(`[${req.method} ${req.path}]`, err);
    }
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
    return;
  }

  if (isPostgrestLikeError(err)) {
    console.error(`[${req.method} ${req.path}] Database error:`, err);
    res.status(500).json({ error: "A database error occurred", code: "DATABASE_ERROR" });
    return;
  }

  console.error(`[${req.method} ${req.path}] Unhandled error:`, err);
  res.status(500).json({ error: "Internal server error", code: "INTERNAL" });
}
