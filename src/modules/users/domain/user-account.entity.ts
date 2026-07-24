import type { Role } from "../../../domain";

/** Pure domain shape for a staff account -- no persistence or HTTP concerns. */
export interface UserAccountEntity {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  hasQrLogin: boolean;
}
