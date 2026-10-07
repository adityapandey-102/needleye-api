import type { Capability } from "./capabilities";

/**
 * The production lifecycle: 16 stages (see STAGE_ORDER), forward-only with ONE
 * exception -- Ready -> Alteration, so a garment can loop Ready -> Alteration ->
 * Ready as often as needed. Delivered is reachable only from Ready. See
 * stageMoveRefusal() and ADR 0008. `orders.production_status` always stores one
 * of these granular values.
 *
 * Alteration sits BEFORE Ready in the order so the board and the tracker read
 * Ready right before Delivered; the main path skips it (QC -> Ready).
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
  { value: "dyeing", label: "Dyeing" },
  { value: "marking", label: "Marking" },
  { value: "cutting", label: "Cutting" },
  { value: "stitching", label: "Stitching" },
  { value: "hand_work", label: "Hand Work" },
  { value: "machine_work", label: "Machine Work" },
  { value: "finishing", label: "Finishing" },
  { value: "quality_check", label: "Quality Check / Trail" },
  { value: "alteration", label: "Alteration" },
  { value: "ready", label: "Ready" },
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
  dyeing: "orders:status:production",
  marking: "orders:status:production",
  cutting: "orders:status:production",
  stitching: "orders:status:production",
  hand_work: "orders:status:production",
  machine_work: "orders:status:production",
  finishing: "orders:status:production",
  quality_check: "orders:status:finalization",
  alteration: "orders:status:finalization",
  ready: "orders:status:finalization",
  delivered: "orders:status:finalization",
};

export function stageCapability(status: GranularStatus): StatusCapability {
  return STAGE_CAPABILITY[status];
}

/** Design-tier stages (kept for repository/report groupings). */
export const DESIGN_STAGE_STATUSES: GranularStatus[] = GRANULAR_STATUS_VALUES.filter(
  (s) => STAGE_CAPABILITY[s] === "orders:status:design",
);

/**
 * Every stage from the first floor stage (Falls/Kutchu) through Delivered -- a
 * REPORTING grouping (it backs the dashboard's "In Production" count), not a
 * permission tier. Deliberately defined by POSITION in the flow rather than by
 * STAGE_CAPABILITY: the finalization tier split Quality Check / Alteration /
 * Delivered off the production tier for permissions only, and deriving this
 * from the tier would have silently dropped QC and Alteration from the
 * in-production count.
 */
export const PRODUCTION_STAGE_STATUSES: GranularStatus[] = GRANULAR_STATUS_VALUES.filter(
  (s) => STAGE_ORDER[s] >= STAGE_ORDER.falls_kutchu,
);

/** Terminal/completed stages. Delivered is the only end state now. */
export const COMPLETED_CANONICAL_STAGES: CanonicalStage[] = ["delivered"];

/** The one stage that should render as an "alarming" (needs-attention) state in the UI. */
export const ALARMING_STATUS: GranularStatus = "alteration";

/** Finished and waiting for the customer -- the only stage Delivered can follow. */
export const READY_STATUS: GranularStatus = "ready";

/** Why a move from `from` to `to` breaks the flow's shape, or null if it doesn't (role checks are separate). */
export type StageMoveRefusal = "same_stage" | "backward" | "deliver_requires_ready";

/**
 * The flow's shape rules, independent of who is asking:
 *   - same stage           -> refused (idempotency / concurrent double-advance)
 *   - into Delivered       -> only from Ready
 *   - backwards            -> only Ready -> Alteration (the alteration loop)
 *   - any other forward move is fine (skips are checked against the role separately)
 */
export function stageMoveRefusal(from: GranularStatus, to: GranularStatus): StageMoveRefusal | null {
  if (from === to) return "same_stage";
  if (to === "delivered" && from !== READY_STATUS) return "deliver_requires_ready";
  if (STAGE_ORDER[to] < STAGE_ORDER[from]) {
    return from === READY_STATUS && to === ALARMING_STATUS ? null : "backward";
  }
  return null;
}

/**
 * The stage a scan or "advance" button moves to next: the next stage on the MAIN
 * path. Alteration is never the default next step (it's a deliberate choice), so
 * QC and Alteration both advance to Ready. Null once Delivered.
 */
export function nextMainStage(current: GranularStatus): GranularStatus | null {
  if (current === "delivered") return null;
  if (current === "quality_check" || current === ALARMING_STATUS) return READY_STATUS;
  return GRANULAR_STATUS_VALUES[STAGE_ORDER[current] + 1] ?? null;
}
