import type { Role } from "../../../../domain";

/** Response shape returned to the client. */
export interface TeamMemberResponseDto {
  id: string;
  fullName: string;
  role: Role;
}
