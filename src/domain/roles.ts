export const ROLES = ["owner_manager", "designer", "master_tailor", "accountant"] as const;

export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  owner_manager: "Owner / Manager",
  designer: "Designer",
  master_tailor: "Master Tailor",
  accountant: "Accountant",
};
