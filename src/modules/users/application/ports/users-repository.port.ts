import type { Role } from "../../../../domain";
import type { UserAccountEntity } from "../../domain/user-account.entity";

export interface ProfileUpdate {
  fullName?: string;
  role?: Role;
  active?: boolean;
}

/** Server-side list filters -- `search` matches name OR email (case-insensitive). */
export interface UserListFilters {
  search?: string;
}

/** Bounded page window, mirroring the Orders module's offset pagination. */
export interface UserListPage {
  limit: number;
  offset: number;
}

/** Persistence contract for the Users module -- pure data access, no business rules. */
export interface UsersRepositoryPort {
  findMany(filters: UserListFilters, page: UserListPage): Promise<UserAccountEntity[]>;
  countMany(filters: UserListFilters): Promise<number>;
  findById(id: string): Promise<UserAccountEntity | null>;
  createUser(email: string, fullName: string, role: Role, password: string): Promise<string>;
  updateProfile(id: string, updates: ProfileUpdate): Promise<void>;
  setPassword(id: string, password: string): Promise<void>;
  setQrToken(profileId: string, tokenHash: string): Promise<void>;
  clearQrToken(profileId: string): Promise<void>;
  banAuthUser(id: string): Promise<void>;
  unbanAuthUser(id: string): Promise<void>;
}
