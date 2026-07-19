import { Router } from "express";
import { inviteUserSchema, updateUserSchema } from "@needleye/shared";
import { requireAuth } from "../../shared/middleware/auth";
import { requireCapability } from "../../shared/middleware/capability";
import { supabaseAdmin } from "../../shared/supabaseAdmin";
import { asyncHandler } from "../../shared/asyncHandler";
import { BadRequestError, InternalError } from "../../shared/errors";

export const usersRouter = Router();

usersRouter.use(requireAuth, requireCapability("users:manage"));

usersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    const { data, error } = await supabaseAdmin
      .from("profiles")
      .select("id, full_name, email, role, active, created_at")
      .order("created_at", { ascending: true });

    if (error) throw new InternalError("Failed to load users");

    res.json({
      users: data.map((row) => ({
        id: row.id,
        fullName: row.full_name,
        email: row.email,
        role: row.role,
        active: row.active,
        createdAt: row.created_at,
      })),
    });
  }),
);

usersRouter.post(
  "/invite",
  asyncHandler(async (req, res) => {
    const { email, fullName, role } = inviteUserSchema.parse(req.body);

    // Sends the actual invite email (captured by Inbucket/Mailpit in local
    // dev). handle_new_user() trigger reads full_name/role from this
    // metadata and creates the matching `profiles` row automatically.
    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName, role },
    });

    if (error) throw new BadRequestError(error.message);
    res.status(201).json({ userId: data.user?.id });
  }),
);

usersRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const parsed = updateUserSchema.parse(req.body);

    const updates: Record<string, unknown> = {};
    if (parsed.fullName !== undefined) updates.full_name = parsed.fullName;
    if (parsed.role !== undefined) updates.role = parsed.role;
    if (parsed.active !== undefined) updates.active = parsed.active;

    if (Object.keys(updates).length === 0) throw new BadRequestError("No fields to update");

    const { error } = await supabaseAdmin.from("profiles").update(updates).eq("id", req.params.id);
    if (error) throw new InternalError("Failed to update user");

    res.status(204).send();
  }),
);

usersRouter.post(
  "/:id/deactivate",
  asyncHandler(async (req, res) => {
    const targetId = req.params.id;

    if (targetId === req.authUserId) {
      throw new BadRequestError("You cannot deactivate your own account");
    }

    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .update({ active: false })
      .eq("id", targetId);

    if (profileError) throw new InternalError("Failed to deactivate user");

    // Also block sign-in at the Auth layer, not just app-level gating.
    const { error: banError } = await supabaseAdmin.auth.admin.updateUserById(targetId!, {
      ban_duration: "876000h",
    });

    if (banError) throw new InternalError("Failed to revoke account access");
    res.status(204).send();
  }),
);
