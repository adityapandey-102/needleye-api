/**
 * One period's ledger figures (a month, or a whole range), summed from
 * ledger_daily (ADR 0008, phase 4). Money as 2dp strings.
 *
 *   total          value of the orders booked in the period (as priced now)
 *   paidSoFar      paid so far -- on any date -- on those orders
 *   cashCollected  money received in the period, from any order
 *
 * Outstanding (total - paidSoFar) is derived by the presenter.
 */
export interface LedgerFigures {
  ordersBooked: number;
  ordersPriced: number;
  total: string;
  paidSoFar: string;
  cashCollected: string;
  paymentsCount: number;
}

export interface LedgerMonthEntity extends LedgerFigures {
  /** YYYY-MM */
  month: string;
}
