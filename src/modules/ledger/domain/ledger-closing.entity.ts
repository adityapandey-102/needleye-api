import type { LedgerFigures } from "./ledger-month.entity";

/** One close or reopen of a month (ADR 0008, phase 5). */
export interface LedgerClosingEntity {
  id: string;
  /** YYYY-MM */
  month: string;
  action: "closed" | "reopened";
  /** The month's figures at closing -- the closing record (closed only). */
  figures: LedgerFigures | null;
  /** Why it was reopened (reopened only). */
  reason: string | null;
  actorName: string | null;
  /** ISO-8601 UTC */
  createdAt: string;
}

/** The register's columns, in display order. */
export const LEDGER_FIELDS = ["ordersBooked", "ordersPriced", "total", "paidSoFar", "cashCollected", "paymentsCount"] as const;
export type LedgerField = (typeof LEDGER_FIELDS)[number];

/** A day whose register row doesn't match a recount of its orders and payments. */
export interface ReconciliationMismatch {
  /** YYYY-MM-DD */
  day: string;
  fields: { field: LedgerField; register: string; actual: string }[];
}

/** A closed month whose cash, or booked orders and total, no longer match its closing record. */
export interface ClosedMonthDrift {
  /** YYYY-MM */
  month: string;
  closedCash: string;
  cashNow: string;
  closedPayments: number;
  paymentsNow: number;
  closedOrders: number;
  ordersNow: number;
  closedTotal: string;
  totalNow: string;
}

/** One run of the check: the register against a recount of the receipts, plus money rules. */
export interface ReconciliationEntity {
  id: string;
  kind: "nightly" | "manual";
  requestedByName: string | null;
  /** ISO-8601 UTC */
  startedAt: string;
  finishedAt: string;
  status: "verified" | "problems";
  daysChecked: number;
  mismatchedDays: number;
  /** Up to 50 mismatched days, newest first. */
  mismatches: ReconciliationMismatch[];
  overpaidOrders: number;
  statusMismatches: number;
  closedMonthDrift: number;
  closedMonths: ClosedMonthDrift[];
}
