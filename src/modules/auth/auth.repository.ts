import { supabaseClient } from "../../common/database/supabase-client";
import { InternalError, BadRequestError } from "../../common/errors/app-error";
import type { BootstrapDto } from "./dto/bootstrap.dto";

/** Persistence contract for the Auth module -- pure data access, no business rules. */
export interface AuthRepository {
  countOwnerManagers(): Promise<number>;
  createOwnerManagerUser(dto: BootstrapDto): Promise<void>;
}

export class SupabaseAuthRepository implements AuthRepository {
  async countOwnerManagers(): Promise<number> {
    const { count, error } = await supabaseClient
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("role", "owner_manager");

    if (error) throw new InternalError("Failed to check bootstrap status");
    return count ?? 0;
  }

  async createOwnerManagerUser(dto: BootstrapDto): Promise<void> {
    const { error } = await supabaseClient.auth.admin.createUser({
      email: dto.email,
      password: dto.password,
      email_confirm: true,
      user_metadata: { full_name: dto.fullName, role: "owner_manager" },
    });

    if (error) throw new BadRequestError(error.message);
  }
}
