import type { Role } from "../../../domain";
import type { UserAccountEntity } from "../domain/user-account.entity";

/** Raw shape returned by the repository's USER_ROW_SELECT projection. */
export interface UserAccountRow {
  id: string;
  full_name: string;
  email: string;
  role: Role;
  active: boolean;
  created_at: string;
  last_login_at: string | null;
  has_qr_login: boolean;
}

export const UserAccountMapper = {
  toEntity(row: UserAccountRow): UserAccountEntity {
    return {
      id: row.id,
      fullName: row.full_name,
      email: row.email,
      role: row.role,
      active: row.active,
      createdAt: row.created_at,
      lastLoginAt: row.last_login_at,
      hasQrLogin: row.has_qr_login,
    };
  },
};
