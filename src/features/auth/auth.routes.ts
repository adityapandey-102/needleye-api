import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../shared/middleware/auth";
import { supabaseAdmin } from "../../shared/supabaseAdmin";
import { asyncHandler } from "../../shared/asyncHandler";
import { BadRequestError, ForbiddenError, InternalError } from "../../shared/errors";

export const authRouter = Router();

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ profile: req.profile });
  }),
);

/**
 * Registration is invite-only in normal operation (Owner/Manager invites
 * staff via /users/invite, which sets their role at invite time). These two
 * endpoints exist solely to bootstrap the very first Owner/Manager account
 * on a fresh install -- they refuse to do anything once one already exists,
 * so this can't be used to self-escalate after go-live.
 */
authRouter.get(
  "/bootstrap-status",
  asyncHandler(async (_req, res) => {
    const { count, error } = await supabaseAdmin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "owner_manager");

    if (error) throw new InternalError("Failed to check bootstrap status");
    res.json({ ownerExists: (count ?? 0) > 0 });
  }),
);

const bootstrapSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  fullName: z.string().trim().min(1),
});

authRouter.post(
  "/bootstrap",
  asyncHandler(async (req, res) => {
    const parsed = bootstrapSchema.parse(req.body);

    const { count, error: countError } = await supabaseAdmin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "owner_manager");

    if (countError) throw new InternalError("Failed to check bootstrap status");
    if ((count ?? 0) > 0) {
      throw new ForbiddenError("An Owner/Manager account already exists. Ask them for an invite.");
    }

    const { error: createError } = await supabaseAdmin.auth.admin.createUser({
      email: parsed.email,
      password: parsed.password,
      email_confirm: true,
      user_metadata: { full_name: parsed.fullName, role: "owner_manager" },
    });

    if (createError) throw new BadRequestError(createError.message);
    res.status(201).json({ ok: true });
  }),
);
