import { z } from "zod";
import { LEDGER_PAGE_MAX } from "../../domain/ledger-month.rules";

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM");

/** GET /ledger/months?from=&to=&limit=&offset= -- months newest first, paged. Defaults: this year so far. */
export const ledgerMonthsQuerySchema = z.object({
  from: month.optional(),
  to: month.optional(),
  limit: z.coerce.number().int().min(1).max(LEDGER_PAGE_MAX).default(12),
  offset: z.coerce.number().int().min(0).default(0),
});

export type LedgerMonthsQuery = z.infer<typeof ledgerMonthsQuerySchema>;

/** GET /ledger/months/export?from=&to= -- every month of the range (at most 240). */
export const ledgerExportQuerySchema = z.object({ from: month, to: month });

export type LedgerExportQuery = z.infer<typeof ledgerExportQuerySchema>;

/** A period's figures. Money as 2dp strings. */
export interface LedgerFiguresDto {
  ordersBooked: number;
  /** Booked orders without a price yet (not in `total`). */
  ordersNotPriced: number;
  /** Value of the orders booked in the period (as priced now). */
  total: string;
  /** Paid so far, on any date, on those orders. */
  paidSoFar: string;
  /** total - paidSoFar: still unpaid on those orders. */
  outstanding: string;
  /** Money received in the period, from any order. */
  cashCollected: string;
  paymentsCount: number;
}

/** A month's books (ADR 0008 phase 5). */
export interface LedgerMonthBooksDto {
  /** closed: no payment dated in the month can be added, edited or removed. */
  status: "open" | "closed";
  /** The month has ended, so it can be closed (this month never has). */
  ended: boolean;
  /** The latest close (closed only). */
  closedAt: string | null;
  closedByName: string | null;
}

export interface LedgerMonthDto extends LedgerFiguresDto {
  /** YYYY-MM */
  month: string;
  books: LedgerMonthBooksDto;
}

/** POST /ledger/months/:month/reopen -- the reason is checked by the domain (3-500 characters). */
export const reopenMonthSchema = z.object({ reason: z.string().max(2000).optional() });

export type ReopenMonthBody = z.infer<typeof reopenMonthSchema>;

/** One close or reopen. */
export interface LedgerClosingDto {
  id: string;
  /** YYYY-MM */
  month: string;
  action: "closed" | "reopened";
  /** The month's figures at closing -- the closing record (closed only). */
  figures: LedgerFiguresDto | null;
  /** Why it was reopened (reopened only). */
  reason: string | null;
  actorName: string | null;
  createdAt: string;
}

/** GET /ledger/months/:month/closings */
export interface LedgerMonthClosingsResponseDto {
  month: string;
  books: LedgerMonthBooksDto;
  /** The month's figures now -- compare with the closing record. */
  figuresNow: LedgerFiguresDto;
  /** Closes and reopens, newest first (at most 50). */
  history: LedgerClosingDto[];
  /** How many there are in all. */
  total: number;
}

/** One run of the check. */
export interface ReconciliationDto {
  id: string;
  kind: "nightly" | "manual";
  requestedByName: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  /** verified: the register matches a recount of every order and payment, and every rule holds. */
  status: "verified" | "problems";
  daysChecked: number;
  mismatchedDays: number;
  /** Up to 50 mismatched days, newest first. */
  mismatches: { day: string; fields: { field: string; register: string; actual: string }[] }[];
  /** Orders paid more than their total. */
  overpaidOrders: number;
  /** Orders whose payment status doesn't match their payments. */
  statusMismatches: number;
  /** Closed months whose cash no longer matches their closing record. */
  closedMonthDrift: number;
  closedMonths: { month: string; closedCash: string; cashNow: string; closedPayments: number; paymentsNow: number }[];
}

/** GET /ledger/reconciliations/latest and POST /ledger/reconciliations */
export interface LedgerVerificationResponseDto {
  timeZone: string;
  /** The most recent check of any kind; null before the first. */
  latest: ReconciliationDto | null;
  /** When the nightly check last ran; null before the first night. */
  lastNightlyAt: string | null;
  /** Over 26 hours since the last nightly check -- the schedule has stopped. */
  nightlyOverdue: boolean;
}

/** GET /ledger/summary -- this month's cards. */
export interface LedgerSummaryResponseDto {
  month: string;
  /** The shop's today (YYYY-MM-DD) -- "paid so far" is as of now. */
  asOf: string;
  timeZone: string;
  figures: LedgerFiguresDto;
}

/** GET /ledger/months */
export interface LedgerMonthsResponseDto {
  from: string;
  to: string;
  /** This page, newest month first (months with no activity read as zeros). */
  months: LedgerMonthDto[];
  /** Months in the range. */
  total: number;
  limit: number;
  offset: number;
  /** The whole range, summed by the API. */
  totals: LedgerFiguresDto;
}

/** GET /ledger/months/export */
export interface LedgerExportResponseDto {
  from: string;
  to: string;
  timeZone: string;
  months: LedgerMonthDto[];
  totals: LedgerFiguresDto;
}
