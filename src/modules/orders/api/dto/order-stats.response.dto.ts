/**
 * Response shape for GET /orders/stats. Payment-related fields are absent
 * entirely (not null) for callers without `payments:read` (master_tailor) --
 * a real server-side omission, matching OrderResponseDto's own payment
 * fields (see order.response.dto.ts).
 */
export interface OrderStatsResponseDto {
  total: number;
  active: number;
  completed: number;
  /** Orders created in the current calendar month. Visible to all roles. */
  thisMonth: number;
  /** Orders in an active production stage (cutting..QC). Visible to all roles. */
  inProduction: number;
  /** Active orders past their delivery due date. Visible to all roles. */
  overdue: number;
  /** Active orders due within 3 days (not overdue). Visible to all roles. */
  urgent: number;
  pendingPayments?: number;
  // Money as 2dp strings.
  collectedRevenue?: string;
  outstandingRevenue?: string;
}
