/**
 * Ported from prototype/script.js. Two parallel vocabularies exist on purpose:
 *  - GRANULAR_STATUSES (12): what the Create/Edit Order form sets.
 *  - CANONICAL_STAGES (10): what the Kanban board groups by.
 * `orders.production_status` always stores a granular value; canonical grouping
 * is a pure derivation via STATUS_ALIASES, never stored redundantly.
 */

export const GRANULAR_STATUSES = [
  { value: "design_pending", label: "Design Pending" },
  { value: "design_approved", label: "Design Approved" },
  { value: "falls_kutchu", label: "Falls / Kutchu" },
  { value: "fabric_purchased", label: "Fabric Purchased" },
  { value: "cutting", label: "Cutting" },
  { value: "stitching", label: "Stitching" },
  { value: "hand_work", label: "Hand Work" },
  { value: "machine_work", label: "Machine Work" },
  { value: "finishing", label: "Finishing" },
  { value: "quality_check", label: "Quality Check" },
  { value: "ready_for_delivery", label: "Ready For Delivery" },
  { value: "delivered", label: "Delivered" },
] as const;

export type GranularStatus = (typeof GRANULAR_STATUSES)[number]["value"];

export const GRANULAR_STATUS_VALUES = GRANULAR_STATUSES.map((s) => s.value) as [
  GranularStatus,
  ...GranularStatus[],
];

export const CANONICAL_STAGES = [
  { value: "designing", label: "Designing" },
  { value: "falls_kutchu", label: "Falls / Kutchu" },
  { value: "fabric_purchase", label: "Fabric Purchase" },
  { value: "cutting", label: "Cutting" },
  { value: "stitching", label: "Stitching" },
  { value: "hand_work", label: "Hand Work" },
  { value: "machine_work", label: "Machine Work" },
  { value: "qc", label: "QC" },
  { value: "ready", label: "Ready" },
  { value: "delivered", label: "Delivered" },
] as const;

export type CanonicalStage = (typeof CANONICAL_STAGES)[number]["value"];

export const CANONICAL_STAGE_VALUES = CANONICAL_STAGES.map((s) => s.value) as [
  CanonicalStage,
  ...CanonicalStage[],
];

/** Granular -> canonical, verbatim port of prototype's STATUS_ALIASES map. */
export const STATUS_ALIASES: Record<GranularStatus, CanonicalStage> = {
  design_pending: "designing",
  design_approved: "designing",
  falls_kutchu: "falls_kutchu",
  fabric_purchased: "fabric_purchase",
  cutting: "cutting",
  stitching: "stitching",
  hand_work: "hand_work",
  machine_work: "machine_work",
  finishing: "qc",
  quality_check: "qc",
  ready_for_delivery: "ready",
  delivered: "delivered",
};

/**
 * Canonical -> representative granular value written when a Kanban card is
 * dropped on that column (e.g. dropping on "QC" writes "quality_check").
 * Keeps `production_status` always holding one of the 12 known granular
 * values, never a mixed vocabulary.
 */
export const CANONICAL_TO_GRANULAR: Record<CanonicalStage, GranularStatus> = {
  designing: "design_pending",
  falls_kutchu: "falls_kutchu",
  fabric_purchase: "fabric_purchased",
  cutting: "cutting",
  stitching: "stitching",
  hand_work: "hand_work",
  machine_work: "machine_work",
  qc: "quality_check",
  ready: "ready_for_delivery",
  delivered: "delivered",
};

export function toCanonicalStage(status: GranularStatus): CanonicalStage {
  return STATUS_ALIASES[status] ?? "designing";
}

export function granularLabel(value: GranularStatus): string {
  return GRANULAR_STATUSES.find((s) => s.value === value)?.label ?? value;
}

export function canonicalLabel(value: CanonicalStage): string {
  return CANONICAL_STAGES.find((s) => s.value === value)?.label ?? value;
}

/** Design-stage vs production-stage split, drives the status:* capabilities. */
export const DESIGN_STAGE_STATUSES: GranularStatus[] = [
  "design_pending",
  "design_approved",
  "fabric_purchased",
];

export const PRODUCTION_STAGE_STATUSES: GranularStatus[] = GRANULAR_STATUS_VALUES.filter(
  (s) => !DESIGN_STAGE_STATUSES.includes(s),
);

export const COMPLETED_CANONICAL_STAGES: CanonicalStage[] = ["ready", "delivered"];
