import type { Role } from "../../../domain";

/** Response shape returned to the client. */
export interface TeamMemberDto {
  id: string;
  fullName: string;
  role: Role;
}
