import type { Role } from "../../../../domain";

/** Response shape returned to the client. */
export interface UserResponseDto {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  active: boolean;
  createdAt: string;
  lastLoginAt: string | null;
  /** Whether a QR login token exists for this account -- never the token/hash itself. */
  hasQrLogin: boolean;
}
