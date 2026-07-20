import { supabaseClient } from "../../common/database/supabase-client";
import { InternalError } from "../../common/errors/app-error";
import type { Role } from "../../domain";

export interface TeamMemberRow {
  id: string;
  full_name: string;
  role: Role;
}

/** Persistence contract for the Team Members module -- pure data access, no business rules. */
export interface TeamMembersRepository {
  findActive(role?: Role): Promise<TeamMemberRow[]>;
}

export class SupabaseTeamMembersRepository implements TeamMembersRepository {
  async findActive(role?: Role): Promise<TeamMemberRow[]> {
    let query = supabaseClient
      .from("profiles")
      .select("id, full_name, role")
      .eq("active", true)
      .order("full_name", { ascending: true });

    if (role) query = query.eq("role", role);

    const { data, error } = await query;
    if (error) throw new InternalError("Failed to load team members");
    return data;
  }
}
