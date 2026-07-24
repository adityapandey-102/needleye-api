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
  pendingPayments?: number;
  collectedRevenue?: number;
  outstandingRevenue?: number;
}
