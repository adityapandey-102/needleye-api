import type { NextFunction, Request, Response } from "express";
import { getCapabilityScope, type Capability } from "../../domain";
import { ForbiddenError, UnauthorizedError } from "../errors/app-error";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireCapability: whether the caller's access is global or limited to their own records. */
      capabilityScope?: boolean | "assigned";
    }
  }
}

/**
 * Rejects the request if the caller's role has no access to `capability` at
 * all. When the role's access is scoped to "assigned" records, the
 * controller/service is responsible for filtering/verifying ownership
 * (designer_id / master_tailor_id / order's designer for payments) -- this
 * middleware only gates the all-or-nothing role check and records the
 * scope on `req` so downstream layers don't have to re-derive it.
 */
export function requireCapability(capability: Capability) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.profile) {
      next(new UnauthorizedError());
      return;
    }

    const scope = getCapabilityScope(req.profile.role, capability);
    if (scope === false) {
      next(new ForbiddenError(`Your role does not have access to '${capability}'`));
      return;
    }

    req.capabilityScope = scope;
    next();
  };
}
