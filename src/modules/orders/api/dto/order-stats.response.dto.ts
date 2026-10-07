/**
 * Response shape for GET /orders/stats. Payment-related fields are absent
 * entirely (not null) for callers without `payments:read` (master_tailor) --
 * a real server-side omission, matching OrderResponseDto's own payment
 * fields (see order.response.dto.ts).
 */
export interface OrderStatsResponseDto {
  total: number;
  active: number;
  /** Every delivered order ever. Deprecated -- kept for older web builds; use deliveredThisMonth. */
  completed: number;
  /** Orders that reached Delivered since the 1st of this month (shop timezone). Visible to all roles. */
  deliveredThisMonth: number;
  /** Orders currently in Ready -- finished, waiting for the customer. Visible to all roles. */
  ready: number;
  /** Orders created in the current calendar month. Visible to all roles. */
  thisMonth: number;
  /** Orders in an active production stage (Falls/Kutchu..Alteration; not Ready or Delivered). Visible to all roles. */
  inProduction: number;
  /** Active orders past their delivery due date. Visible to all roles. */
  overdue: number;
  /** Active orders due within 3 days (not overdue). Visible to all roles. */
  urgent: number;
  pendingPayments?: number;
  /** Orders with no price yet (ADR 0008). Absent for roles without payments:read. */
  notPriced?: number;
  // Money as 2dp strings.
  collectedRevenue?: string;
  outstandingRevenue?: string;
}
