import { BadRequestError, ForbiddenError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import type { Role } from "../../../domain";

/** Roles that self-manage their own password after their first login. */
const SELF_MANAGED_AFTER_FIRST_LOGIN: Role[] = ["owner_manager", "accountant"];

/**
 * Owner/Manager can always regenerate a Designer's or Master Tailor's
 * password. For Owner/Manager and Accountant accounts, this is only
 * available until that account's first real login -- after that, they're
 * expected to manage their own password (reset-password flow), not have it
 * reset for them. Throws directly rather than returning a boolean: see
 * docs/adr/0002-repository-port-implementation-split.md for why domain
 * rules in this codebase throw AppError rather than a parallel domain-error type.
 */
export function assertPasswordCanBeRegenerated(role: Role, lastLoginAt: string | null): void {
  if (SELF_MANAGED_AFTER_FIRST_LOGIN.includes(role) && lastLoginAt) {
    throw new ForbiddenError(
      "This account has already logged in and manages its own password now -- use the password-reset flow instead.",
      ERROR_CODES.USER_PASSWORD_SELF_MANAGED,
    );
  }
}

/** QR login is Master Tailor-only -- see the README's Flow Map for why. */
export function assertRoleSupportsQrLogin(role: Role): void {
  if (role !== "master_tailor") {
    throw new BadRequestError("QR login is only available for Master Tailor accounts", ERROR_CODES.USER_QR_ROLE_UNSUPPORTED);
  }
}
