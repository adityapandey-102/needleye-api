import type { NextFunction, Request, Response } from "express";

type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

/**
 * Express 4 does not catch rejected promises from async handlers -- an
 * awaited throw inside one would crash the process instead of reaching the
 * error middleware. Wrapping every async handler/middleware in this forwards
 * the rejection to next(err) so shared/middleware/errorHandler.ts always
 * gets a chance to turn it into a proper response.
 */
export function asyncHandler(fn: AsyncRouteHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
