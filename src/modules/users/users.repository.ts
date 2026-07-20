import { supabaseClient } from "../../common/database/supabase-client";
import { BadRequestError, InternalError } from "../../common/errors/app-error";
import type { Role } from "../../domain";

export interface UserRow {
  id: string;
  full_name: string;
  email: string;
  role: Role;
  active: boolean;
  created_at: string;
}

export interface ProfileUpdate {
  full_name?: string;
  role?: Role;
  active?: boolean;
}

/** Persistence contract for the Users module -- pure data access, no business rules. */
export interface UsersRepository {
  findAll(): Promise<UserRow[]>;
  updateProfile(id: string, updates: ProfileUpdate): Promise<void>;
  inviteUser(email: string, fullName: string, role: Role): Promise<string | undefined>;
  banAuthUser(id: string): Promise<void>;
}

export class SupabaseUsersRepository implements UsersRepository {
  async findAll(): Promise<UserRow[]> {
    const { data, error } = await supabaseClient
      .from("profiles")
      .select("id, full_name, email, role, active, created_at")
      .order("created_at", { ascending: true });

    if (error) throw new InternalError("Failed to load users");
    return data;
  }

  async updateProfile(id: string, updates: ProfileUpdate): Promise<void> {
    const { error } = await supabaseClient.from("profiles").update(updates).eq("id", id);
    if (error) throw new InternalError("Failed to update user");
  }

  async inviteUser(email: string, fullName: string, role: Role): Promise<string | undefined> {
    // Sends the actual invite email (captured by Inbucket/Mailpit in local
    // dev). handle_new_user() trigger reads full_name/role from this
    // metadata and creates the matching `profiles` row automatically.
    const { data, error } = await supabaseClient.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName, role },
    });

    if (error) throw new BadRequestError(error.message);
    return data.user?.id;
  }

  async banAuthUser(id: string): Promise<void> {
    // Blocks sign-in at the Auth layer, not just app-level gating.
    const { error } = await supabaseClient.auth.admin.updateUserById(id, { ban_duration: "876000h" });
    if (error) throw new InternalError("Failed to revoke account access");
  }
}
