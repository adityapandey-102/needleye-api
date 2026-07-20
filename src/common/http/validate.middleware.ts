import type { NextFunction, Request, Response } from "express";
import type { ZodSchema } from "zod";

/**
 * Validation layer, kept separate from both the controller and the service:
 * this middleware parses+validates `req.body` against a zod schema (a DTO
 * definition) and replaces `req.body` with the validated, typed result
 * before the controller ever calls into the service layer. Services can
 * then assume their input DTO is already well-formed -- they only apply
 * business rules, never shape/type validation.
 *
 * A thrown ZodError here is a synchronous throw inside a synchronous
 * Express middleware, which Express's default error handling already
 * forwards to the next error middleware -- no asyncHandler wrapper needed.
 */
export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.body = schema.parse(req.body);
    next();
  };
}

/** Same idea for query-string parameters (e.g. list filters). */
export function validateQuery<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    req.query = schema.parse(req.query) as typeof req.query;
    next();
  };
}
