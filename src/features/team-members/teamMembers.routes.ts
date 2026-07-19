import { Router } from "express";
import { ROLES } from "@needleye/shared";
import { requireAuth } from "../../shared/middleware/auth";
import { supabaseAdmin } from "../../shared/supabaseAdmin";
import { asyncHandler } from "../../shared/asyncHandler";
import { BadRequestError, InternalError } from "../../shared/errors";

export const teamMembersRouter = Router();

teamMembersRouter.use(requireAuth);

/** Lightweight lookup backing the designer/master-tailor selects and filters -- all authenticated roles can read it. */
teamMembersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const role = typeof req.query.role === "string" ? req.query.role : undefined;
    if (role && !(ROLES as readonly string[]).includes(role)) {
      throw new BadRequestError(`Invalid role filter: ${role}`);
    }

    let query = supabaseAdmin
      .from("profiles")
      .select("id, full_name, role")
      .eq("active", true)
      .order("full_name", { ascending: true });

    if (role) query = query.eq("role", role);

    const { data, error } = await query;
    if (error) throw new InternalError("Failed to load team members");

    res.json({ members: data.map((row) => ({ id: row.id, fullName: row.full_name, role: row.role })) });
  }),
);
