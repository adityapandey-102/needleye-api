/**
 * "Today" as the SHOP sees it -- a YYYY-MM-DD date in the business timezone
 * (env.BUSINESS_TIMEZONE, default Asia/Kolkata).
 *
 * Why this exists: `new Date().toISOString().slice(0, 10)` is today in UTC,
 * which in India is 5h30m behind. Between midnight and 05:30 IST it returns
 * YESTERDAY -- a payment recorded at 00:30 on the 1st of a month was dated the
 * last day of the previous month (and counted in that month's revenue), and a
 * new order's default booking date was a day early. Every "today" the business
 * sees must come from here.
 */
export function businessToday(now: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** The first day of the month `monthsBack` months before `today` (YYYY-MM-DD), pure date maths in UTC. */
export function monthStartMonthsBack(today: string, monthsBack: number): string {
  const [y, m] = today.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1 - monthsBack, 1)).toISOString().slice(0, 10);
}

/** YYYY-MM-DD that is a real calendar date (rejects 2026-02-31 and anything not in that shape). */
export function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
