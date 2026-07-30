/**
 * Response for GET /orders/revenue -- the monthly revenue report (owner_manager
 * / accountant only, `reports:financial`). `cycleStartDay` is the accounting
 * cycle's start day-of-month (1 = calendar month); `from`/`to` echo the
 * requested inclusive date window; `periods` is the collected-revenue history,
 * oldest first.
 */
export interface RevenuePeriodDto {
  periodStart: string;
  collected: number;
  paymentCount: number;
}

export interface RevenueResponseDto {
  cycleStartDay: number;
  from: string;
  to: string;
  periods: RevenuePeriodDto[];
}
