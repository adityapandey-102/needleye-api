import { ForbiddenError } from "../../../common/errors/app-error";

/**
 * Registration is invite-only in normal operation (Owner/Manager creates
 * every other account directly, via the Users module, with a generated
 * password). Bootstrap exists solely to create the very first Owner/Manager
 * account on a fresh install -- it refuses to run once one already exists,
 * so it can't be used to self-escalate after go-live.
 */
export function assertNoOwnerManagerExists(existingOwnerManagerCount: number): void {
  if (existingOwnerManagerCount > 0) {
    throw new ForbiddenError("An Owner/Manager account already exists. Ask them for an invite.");
  }
}
