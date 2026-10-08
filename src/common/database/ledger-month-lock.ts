/**
 * The per-month advisory lock (ADR 0008, phase 5), two-int form:
 * (LEDGER_MONTH_LOCK_NAMESPACE, public.ledger_month_key(<any day of the month>)).
 *
 * Closing or reopening a month's books takes it EXCLUSIVELY (Ledger module); a
 * payment change takes it SHARED for each month it touches (Payments module),
 * and so does the database guard payments_closed_month_guard. So a payment can
 * never land in a month while it's being closed, and a close never misses a
 * payment that was in flight -- it waits for it, then counts it.
 */
export const LEDGER_MONTH_LOCK_NAMESPACE = 4203;
