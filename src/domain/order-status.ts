import type { Capability } from "./capabilities";

/**
 * The production lifecycle. A single linear, forward-only flow of 13 stages
 * (see STAGE_ORDER). `orders.production_status` always stores one of these
 * granular values.
 *
 * A parallel CANONICAL_STAGES vocabulary still exists so the Kanban board has a
 * stable grouping key, but the flow is now effectively 1:1 (each granular stage
 * is its own canonical column).
 */
export const GRANULAR_STATUSES = [
  { value: "design_pending", label: "Design Pending" },
  { value: "design_approved", label: "Design Approved" },
  { value: "production_manager_received", label: "Production Manager Received" },
  { value: "falls_kutchu", label: "Falls / Kutchu" },
  { value: "fabric_purchased", label: "Fabric Purchased" },
  { value: "cutting", label: "Cutting" },
  { value: "stitching", label: "Stitching" },
  { value: "hand_work", label: "Hand Work" },
  { value: "machine_work", label: "Machine Work" },
  { value: "finishing", label: "Finishing" },
  { value: "quality_check", label: "Quality Check / Trail" },
  { value: "alteration", label: "Alteration" },
  { value: "delivered", label: "Delivered" },
] as const;

export type GranularStatus = (typeof GRANULAR_STATUSES)[number]["value"];

export const GRANULAR_STATUS_VALUES = GRANULAR_STATUSES.map((s) => s.value) as [
  GranularStatus,
  ...GranularStatus[],
];

/** Zero-based position of each stage in the linear flow -- backs the forward-only rule. */
export const STAGE_ORDER: Record<GranularStatus, number> = Object.fromEntries(
  GRANULAR_STATUS_VALUES.map((value, index) => [value, index]),
) as Record<GranularStatus, number>;

export function stageIndex(status: GranularStatus): number {
  return STAGE_ORDER[status];
}

export const CANONICAL_STAGES = GRANULAR_STATUSES.map((s) => ({ value: s.value, label: s.label }));

export type CanonicalStage = GranularStatus;

export const CANONICAL_STAGE_VALUES = GRANULAR_STATUS_VALUES;

/** Granular -> canonical. Now 1:1 (each stage is its own column). */
export const STATUS_ALIASES: Record<GranularStatus, CanonicalStage> = Object.fromEntries(
  GRANULAR_STATUS_VALUES.map((value) => [value, value]),
) as Record<GranularStatus, CanonicalStage>;

/** Canonical -> representative granular value (1:1). */
export const CANONICAL_TO_GRANULAR: Record<CanonicalStage, GranularStatus> = STATUS_ALIASES;

export function toCanonicalStage(status: GranularStatus): CanonicalStage {
  return STATUS_ALIASES[status] ?? "design_pending";
}

export function granularLabel(value: GranularStatus): string {
  return GRANULAR_STATUSES.find((s) => s.value === value)?.label ?? value;
}

export function canonicalLabel(value: CanonicalStage): string {
  return CANONICAL_STAGES.find((s) => s.value === value)?.label ?? value;
}

/**
 * Which capability tier gates moving an order INTO each stage. Checked purely
 * by role -- assignment is deliberately NOT considered (whoever receives the
 * garment on the floor scans it and advances the stage). See
 * domain/../order-status.rules.ts.
 */
type StatusCapability = Extract<Capability, `orders:status:${string}`>;

export const STAGE_CAPABILITY: Record<GranularStatus, StatusCapability> = {
  design_pending: "orders:status:design",
  design_approved: "orders:status:design",
  production_manager_received: "orders:status:pm_received",
  falls_kutchu: "orders:status:production",
  fabric_purchased: "orders:status:production",
  cutting: "orders:status:production",
  stitching: "orders:status:production",
  hand_work: "orders:status:production",
  machine_work: "orders:status:production",
  finishing: "orders:status:production",
  quality_check: "orders:status:production",
  alteration: "orders:status:production",
  delivered: "orders:status:production",
};

export function stageCapability(status: GranularStatus): StatusCapability {
  return STAGE_CAPABILITY[status];
}

/** Design-tier stages (kept for repository/report groupings). */
export const DESIGN_STAGE_STATUSES: GranularStatus[] = GRANULAR_STATUS_VALUES.filter(
  (s) => STAGE_CAPABILITY[s] === "orders:status:design",
);

/** Production-tier stages (everything the floor works, incl. Delivered). */
export const PRODUCTION_STAGE_STATUSES: GranularStatus[] = GRANULAR_STATUS_VALUES.filter(
  (s) => STAGE_CAPABILITY[s] === "orders:status:production",
);

/** Terminal/completed stages. Delivered is the only end state now. */
export const COMPLETED_CANONICAL_STAGES: CanonicalStage[] = ["delivered"];

/** The one stage that should render as an "alarming" (needs-attention) state in the UI. */
export const ALARMING_STATUS: GranularStatus = "alteration";
