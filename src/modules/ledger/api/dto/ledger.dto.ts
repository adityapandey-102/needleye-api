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

export interface LedgerMonthDto extends LedgerFiguresDto {
  /** YYYY-MM */
  month: string;
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
