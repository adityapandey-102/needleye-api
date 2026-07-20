import type { Role } from "./roles";

/** The authenticated caller's identity + role -- attached to every request by common/middleware/auth.middleware.ts. */
export interface Profile {
  id: string;
  fullName: string;
  email: string;
  role: Role;
  active: boolean;
  createdAt: string;
}
