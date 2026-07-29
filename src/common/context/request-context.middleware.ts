import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { runWithRequestContext } from "./request-context";

/**
 * Establishes the per-request AsyncLocalStorage context for the rest of the
 * chain. Mounted right after the request logger (which sets `req.id`) so the
 * context's requestId matches the id pino-http stamps on its own req/res log
 * lines -- one id ties together the request log, every application log during
 * that request, slow-query logs, audit records, and the error response.
 *
 * Wrapping `next()` in runWithRequestContext means every downstream
 * middleware, controller, service, and repository -- and everything they
 * await -- runs inside this context.
 */
export function requestContextMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const headerId = req.headers["x-request-id"];
  const requestId = typeof req.id === "string" ? req.id : typeof headerId === "string" ? headerId : randomUUID();
  runWithRequestContext({ requestId }, () => next());
}
