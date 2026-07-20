import type { Role } from "../../../domain";

/** Response shape returned to the client. */
export interface UserDto {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  active: boolean;
  createdAt: string;
}
