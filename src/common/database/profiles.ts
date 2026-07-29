import { eq } from "drizzle-orm";
import { db } from "./drizzle-client";
// Cross-module Infrastructure-only read: `profiles` is owned by the Users
// module's schema. See docs/adr/0003-per-module-schema-ownership.md.
import { profiles } from "../../modules/users/infrastructure/profile.schema";
import { ForbiddenError, InternalError } from "../errors/app-error";
import { ERROR_CODES } from "../errors/error-codes";
import type { Profile } from "../../domain";

/**
 * Loads the `profiles` row for an already-authenticated user and enforces
 * the "must exist and be active" rule. Lives in common/ (not the auth
 * module) because the auth middleware -- which every module's routes
 * depend on -- needs it too, and common/ is the one place every module is
 * already allowed to depend on.
 */
export async function fetchActiveProfile(userId: string): Promise<Profile> {
  let row;
  try {
    [row] = await db.select().from(profiles).where(eq(profiles.id, userId)).limit(1);
  } catch {
    throw new InternalError("Failed to load profile");
  }

  if (!row) throw new ForbiddenError("No profile found for this account", ERROR_CODES.AUTH_PROFILE_MISSING);
  if (!row.active) throw new ForbiddenError("This account has been deactivated", ERROR_CODES.AUTH_ACCOUNT_DEACTIVATED);

  return {
    id: row.id,
    fullName: row.fullName,
    email: row.email,
    role: row.role,
    active: row.active,
    createdAt: row.createdAt.toISOString(),
  };
}
