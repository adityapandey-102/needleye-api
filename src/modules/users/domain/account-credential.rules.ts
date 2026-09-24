import { BadRequestError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import type { Role } from "../../../domain";

/**
 * Roles that can be issued a printed QR login card (scan it to sign in, no
 * typing): Designer, Master Tailor, Production Manager, and Worker -- the people
 * who move between the floor and the counter. Every one of them keeps their
 * normal email + password login too; the QR card is an additional way in.
 *
 * Owner/Manager and Accountant are deliberately excluded. A QR card is a
 * printed bearer credential -- whoever holds the card is logged in as that
 * person -- and those two roles carry the pricing, payment, and staff-management
 * powers, which are not worth exposing to a lost or photographed card.
 *
 * This gates ISSUING a card (UsersService.generateQrToken). Signing in with a
 * card (/auth/qr-login) needs no role check: it only works for a token that was
 * issued here in the first place.
 */
const QR_LOGIN_ROLES: Role[] = ["designer", "master_tailor", "production_manager", "worker"];

/** True if this role can be issued a QR login card. */
export function roleSupportsQrLogin(role: Role): boolean {
  return QR_LOGIN_ROLES.includes(role);
}

/**
 * Throws directly rather than returning a boolean: see
 * docs/adr/0002-repository-port-implementation-split.md for why domain rules in
 * this codebase throw AppError rather than a parallel domain-error type.
 */
export function assertRoleSupportsQrLogin(role: Role): void {
  if (!roleSupportsQrLogin(role)) {
    throw new BadRequestError(
      "QR login is only available for Designer, Master Tailor, Production Manager, and Worker accounts",
      ERROR_CODES.USER_QR_ROLE_UNSUPPORTED,
    );
  }
}
