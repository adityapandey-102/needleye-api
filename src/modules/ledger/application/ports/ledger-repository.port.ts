import type { LedgerFigures, LedgerMonthEntity } from "../../domain/ledger-month.entity";

/** What the Ledger module needs from persistence. Read-only: ledger_daily is written by database triggers. */
export interface LedgerRepositoryPort {
  /** The given months' figures (one grouped read of ledger_daily). Months with no activity are absent. */
  findMonths(months: string[]): Promise<LedgerMonthEntity[]>;
  /** The figures for every day in [fromDay, toDayExclusive). */
  sumRange(fromDay: string, toDayExclusive: string): Promise<LedgerFigures>;
}
