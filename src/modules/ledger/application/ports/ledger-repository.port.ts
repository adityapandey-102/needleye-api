import type { LedgerFigures, LedgerMonthEntity } from "../../domain/ledger-month.entity";
import type { LedgerClosingEntity, ReconciliationEntity } from "../../domain/ledger-closing.entity";

/** Runs after the month's exclusive lock, with whether the month is closed right now; throws to refuse. */
export type MonthToggleGuard = (isClosed: boolean) => void;

/**
 * What the Ledger module needs from persistence. ledger_daily is read-only
 * here (database triggers write it); closings are appended under the month's
 * lock; checks are run by the ledger_reconcile() database function.
 */
export interface LedgerRepositoryPort {
  /** The given months' figures (one grouped read of ledger_daily). Months with no activity are absent. */
  findMonths(months: string[]): Promise<LedgerMonthEntity[]>;
  /** The figures for every day in [fromDay, toDayExclusive). */
  sumRange(fromDay: string, toDayExclusive: string): Promise<LedgerFigures>;

  /** The latest close or reopen of each given month. Months never closed are absent. */
  findLatestClosings(months: string[]): Promise<LedgerClosingEntity[]>;
  /** A month's closes and reopens, newest first, at most `limit` -- and how many there are. */
  listClosings(month: string, limit: number): Promise<{ items: LedgerClosingEntity[]; total: number }>;
  /** Closes the month, storing its figures as they are now -- under the month's exclusive lock. */
  closeMonth(month: string, actorId: string, guard: MonthToggleGuard): Promise<LedgerClosingEntity>;
  /** Reopens the month with a reason -- under the month's exclusive lock. */
  reopenMonth(month: string, actorId: string, reason: string, guard: MonthToggleGuard): Promise<LedgerClosingEntity>;

  /** Runs the check now; null when another check is already running. */
  runReconciliation(requestedBy: string): Promise<ReconciliationEntity | null>;
  /** The most recent check of any kind, and when the nightly one last ran. */
  findLatestReconciliations(): Promise<{ latest: ReconciliationEntity | null; lastNightlyAt: string | null }>;
}
