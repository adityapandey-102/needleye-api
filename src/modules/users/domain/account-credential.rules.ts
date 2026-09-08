import { BadRequestError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import type { Role } from "../../../domain";

/**
 * Roles that log in by scanning a printed QR card instead of typing a password
 * (shop-floor staff who don't manage their own credentials): Master Tailor and
 * Worker. Owner/Manager, Designer, Production Manager, and Accountant use a
 * normal email + password login.
 */
const QR_LOGIN_ROLES: Role[] = ["master_tailor", "worker"];

/** True if this role logs in via a QR card. */
export function roleSupportsQrLogin(role: Role): boolean {
  return QR_LOGIN_ROLES.includes(role);
}

/**
 * QR login is available for shop-floor roles (Master Tailor, Worker). Throws
 * directly rather than returning a boolean: see
 * docs/adr/0002-repository-port-implementation-split.md for why domain rules in
 * this codebase throw AppError rather than a parallel domain-error type.
 */
export function assertRoleSupportsQrLogin(role: Role): void {
  if (!roleSupportsQrLogin(role)) {
    throw new BadRequestError(
      "QR login is only available for Master Tailor and Worker accounts",
      ERROR_CODES.USER_QR_ROLE_UNSUPPORTED,
    );
  }
}
