import type { Request, Response, NextFunction } from "express";
import type { Profile } from "../../domain";
import { supabaseClient } from "../database/supabase-client";
import { asyncHandler } from "../http/async-handler";
import { ForbiddenError, InternalError, UnauthorizedError } from "../errors/app-error";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      authUserId?: string;
      profile?: Profile;
    }
  }
}

/**
 * Verifies the bearer token against Supabase Auth, then loads the matching
 * `profiles` row (role, active) via the service-role client. `profiles.role`
 * is the authorization source of truth -- not client-writable JWT metadata.
 */
export const requireAuth = asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
  const authHeader = req.header("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;

  if (!token) throw new UnauthorizedError("Missing bearer token");

  const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
  if (userError || !userData.user) throw new UnauthorizedError("Invalid or expired session");

  const { data: profileRow, error: profileError } = await supabaseClient
    .from("profiles")
    .select("id, full_name, email, role, active, created_at")
    .eq("id", userData.user.id)
    .single();

  if (profileError) throw new InternalError("Failed to load your profile");
  if (!profileRow) throw new ForbiddenError("No profile found for this account");
  if (!profileRow.active) throw new ForbiddenError("This account has been deactivated");

  req.authUserId = userData.user.id;
  req.profile = {
    id: profileRow.id,
    fullName: profileRow.full_name,
    email: profileRow.email,
    role: profileRow.role,
    active: profileRow.active,
    createdAt: profileRow.created_at,
  };

  next();
});
