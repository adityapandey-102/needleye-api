import type { Role } from "../../../../domain";
import type { UserAccountEntity } from "../../domain/user-account.entity";

export interface ProfileUpdate {
  fullName?: string;
  role?: Role;
  active?: boolean;
}

/** Persistence contract for the Users module -- pure data access, no business rules. */
export interface UsersRepositoryPort {
  findAll(): Promise<UserAccountEntity[]>;
  findById(id: string): Promise<UserAccountEntity | null>;
  createUser(email: string, fullName: string, role: Role, password: string): Promise<string>;
  updateProfile(id: string, updates: ProfileUpdate): Promise<void>;
  setPassword(id: string, password: string): Promise<void>;
  setQrToken(profileId: string, tokenHash: string): Promise<void>;
  clearQrToken(profileId: string): Promise<void>;
  banAuthUser(id: string): Promise<void>;
}
