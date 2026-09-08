/**
 * Response for GET /orders/ledger-events -- the payment-ledger activity feed
 * (owner_manager/accountant, `reports:financial`). Each event is one
 * append-only audit record for a payment being recorded, edited, or removed,
 * decoded into a display-ready shape: who did it, when, on which order, and
 * what changed. Backs the "Ledger Activity" history on the revenue page.
 */
export interface LedgerAmountSnapshot {
  /** Money as a 2dp string. */
  amount: string;
  method: string;
}

export interface LedgerEventDto {
  id: string;
  /** created = payment recorded, updated = edited, deleted = removed. */
  action: "created" | "updated" | "deleted";
  /** ISO-8601 UTC timestamp of the event. */
  at: string;
  /** Name of the staff member who performed the action (null if the account was since removed). */
  actorName: string | null;
  orderId: string | null;
  orderNumber: string | null;
  /** created/deleted: the payment's amount+method. Absent for updates (see before/after). */
  snapshot?: LedgerAmountSnapshot;
  /** updated: the payment's values before the edit. */
  before?: LedgerAmountSnapshot;
  /** updated: the payment's values after the edit. */
  after?: LedgerAmountSnapshot;
}

export interface LedgerEventsResponseDto {
  events: LedgerEventDto[];
  /** Total events matching the range, ignoring pagination -- backs the pager. */
  total: number;
  limit: number;
  offset: number;
  /** The inclusive date window the feed covers (YYYY-MM-DD), echoing the resolved request. */
  from: string;
  to: string;
}
