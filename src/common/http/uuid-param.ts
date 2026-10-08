import type { NextFunction, Request, RequestHandler, Response } from "express";
import { NotFoundError } from "../errors/app-error";
import type { ErrorCode } from "../errors/error-codes";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * For `router.param(name, ...)`: an id that isn't a UUID can't name any row,
 * so it's a 404 before any query runs -- instead of Postgres refusing the uuid
 * cast and the request ending as a 500 "database error" (it did, e.g. for
 * GET /orders/abc).
 */
export function uuidParam(code: ErrorCode, what: string) {
  return (_req: Request, _res: Response, next: NextFunction, value: string): void => {
    next(UUID.test(value) ? undefined : new NotFoundError(`${what} not found`, code));
  };
}

/** The same check as middleware, for a param a parent router defined (e.g. :orderId on a mergeParams router). */
export function requireUuidParam(name: string, code: ErrorCode, what: string): RequestHandler {
  return (req, _res, next) => {
    const value = req.params[name];
    next(value === undefined || UUID.test(value) ? undefined : new NotFoundError(`${what} not found`, code));
  };
}
