import type { Role } from "../../../domain";

/**
 * Pure domain entity. No business rules exist for this module beyond "an
 * active profile, optionally filtered by role" -- an empty domain beyond
 * this entity is honest for a lookup-shaped module, not a sign the layout
 * doesn't fit (see docs/adr/0001-feature-based-clean-architecture-per-module.md).
 */
export interface TeamMemberEntity {
  id: string;
  fullName: string;
  role: Role;
}
