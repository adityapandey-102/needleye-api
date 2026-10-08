import { and, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { db } from "../../../common/database/drizzle-client";
import { LEDGER_MONTH_LOCK_NAMESPACE } from "../../../common/database/ledger-month-lock";
import { getRequestContext } from "../../../common/context/request-context";
import { AppError, InternalError } from "../../../common/errors/app-error";
import { toMoneyString } from "../../../common/money/money";
// Cross-module Infrastructure-only read: `profiles` is owned by the Users
// module's schema -- for the names of who closed, reopened or checked. See
// docs/adr/0003-per-module-schema-ownership.md.
import { profiles } from "../../users/infrastructure/profile.schema";
import { ledgerDaily, ledgerMonthClosings, ledgerReconciliations } from "./ledger.schema";
import { addMonths, monthStart } from "../domain/ledger-month.rules";
import { assertAllPriced } from "../domain/ledger-closing.rules";
import { LEDGER_FIELDS, type ClosedMonthDrift, type LedgerClosingEntity, type LedgerField, type ReconciliationEntity, type ReconciliationMismatch } from "../domain/ledger-closing.entity";
import type { LedgerRepositoryPort, MonthToggleGuard } from "../application/ports/ledger-repository.port";
import type { LedgerFigures, LedgerMonthEntity } from "../domain/ledger-month.entity";

const FIGURES = {
  ordersBooked: sql<string>`coalesce(sum(${ledgerDaily.ordersBooked}), 0)`,
  ordersPriced: sql<string>`coalesce(sum(${ledgerDaily.ordersPriced}), 0)`,
  total: sql<string>`coalesce(sum(${ledgerDaily.bookedTotal}), 0)`,
  paidSoFar: sql<string>`coalesce(sum(${ledgerDaily.paidOnBooked}), 0)`,
  cashCollected: sql<string>`coalesce(sum(${ledgerDaily.cashCollected}), 0)`,
  paymentsCount: sql<string>`coalesce(sum(${ledgerDaily.paymentsCount}), 0)`,
};

function toFigures(row: Record<keyof typeof FIGURES, string | number> | undefined): LedgerFigures {
  return {
    ordersBooked: Number(row?.ordersBooked ?? 0),
    ordersPriced: Number(row?.ordersPriced ?? 0),
    total: toMoneyString(row?.total ?? 0),
    paidSoFar: toMoneyString(row?.paidSoFar ?? 0),
    cashCollected: toMoneyString(row?.cashCollected ?? 0),
    paymentsCount: Number(row?.paymentsCount ?? 0),
  };
}

const CLOSING_SELECT = {
  id: ledgerMonthClosings.id,
  month: sql<string>`to_char(${ledgerMonthClosings.month}, 'YYYY-MM')`,
  action: ledgerMonthClosings.action,
  ordersBooked: ledgerMonthClosings.ordersBooked,
  ordersPriced: ledgerMonthClosings.ordersPriced,
  bookedTotal: ledgerMonthClosings.bookedTotal,
  paidOnBooked: ledgerMonthClosings.paidOnBooked,
  cashCollected: ledgerMonthClosings.cashCollected,
  paymentsCount: ledgerMonthClosings.paymentsCount,
  reason: ledgerMonthClosings.reason,
  actorName: profiles.fullName,
  createdAt: ledgerMonthClosings.createdAt,
};

type ClosingRow = {
  id: string;
  month: string;
  action: "closed" | "reopened";
  ordersBooked: number | null;
  ordersPriced: number | null;
  bookedTotal: string | null;
  paidOnBooked: string | null;
  cashCollected: string | null;
  paymentsCount: number | null;
  reason: string | null;
  actorName: string | null;
  createdAt: Date;
};

function toClosing(row: ClosingRow): LedgerClosingEntity {
  return {
    id: row.id,
    month: row.month,
    action: row.action,
    figures:
      row.action === "closed"
        ? {
            ordersBooked: row.ordersBooked ?? 0,
            ordersPriced: row.ordersPriced ?? 0,
            total: toMoneyString(row.bookedTotal ?? 0),
            paidSoFar: toMoneyString(row.paidOnBooked ?? 0),
            cashCollected: toMoneyString(row.cashCollected ?? 0),
            paymentsCount: row.paymentsCount ?? 0,
          }
        : null,
    reason: row.reason,
    actorName: row.actorName,
    createdAt: row.createdAt.toISOString(),
  };
}

const RECONCILIATION_SELECT = {
  id: ledgerReconciliations.id,
  kind: ledgerReconciliations.kind,
  requestedByName: profiles.fullName,
  startedAt: ledgerReconciliations.startedAt,
  finishedAt: ledgerReconciliations.finishedAt,
  status: ledgerReconciliations.status,
  daysChecked: ledgerReconciliations.daysChecked,
  mismatchedDays: ledgerReconciliations.mismatchedDays,
  mismatches: ledgerReconciliations.mismatches,
  overpaidOrders: ledgerReconciliations.overpaidOrders,
  statusMismatches: ledgerReconciliations.statusMismatches,
  closedMonthDrift: ledgerReconciliations.closedMonthDrift,
  details: ledgerReconciliations.details,
};

const MONEY_FIELDS: ReadonlySet<LedgerField> = new Set(["total", "paidSoFar", "cashCollected"]);

/** A jsonb scalar the check wrote (a number, or numeric-as-text); anything else reads as 0. */
function scalar(x: unknown): string {
  return typeof x === "string" || typeof x === "number" ? String(x) : "0";
}

/** ledger_reconcile() stores each mismatched day as { day, <field>: { register, actual } } -- jsonb, so key order is lost; fields come back in register order. */
function toMismatch(raw: Record<string, unknown>): ReconciliationMismatch {
  const fields: ReconciliationMismatch["fields"] = [];
  for (const field of LEDGER_FIELDS) {
    const v = raw[field] as { register?: unknown; actual?: unknown } | undefined;
    if (!v) continue;
    const fmt = (x: unknown) => (MONEY_FIELDS.has(field) ? toMoneyString(scalar(x)) : scalar(x));
    fields.push({ field, register: fmt(v.register), actual: fmt(v.actual) });
  }
  return { day: scalar(raw.day), fields };
}

function toDrift(raw: Record<string, unknown>): ClosedMonthDrift {
  return {
    month: scalar(raw.month),
    closedCash: toMoneyString(scalar(raw.closedCash)),
    cashNow: toMoneyString(scalar(raw.cashNow)),
    closedPayments: Number(scalar(raw.closedPayments)),
    paymentsNow: Number(scalar(raw.paymentsNow)),
    // Older checks (before 2026-10-09) didn't record orders or totals.
    closedOrders: Number(scalar(raw.closedOrders ?? raw.ordersNow)),
    ordersNow: Number(scalar(raw.ordersNow)),
    closedTotal: toMoneyString(scalar(raw.closedTotal ?? raw.totalNow)),
    totalNow: toMoneyString(scalar(raw.totalNow)),
  };
}

type ReconciliationRow = {
  id: string;
  kind: "nightly" | "manual";
  requestedByName: string | null;
  startedAt: Date;
  finishedAt: Date;
  status: "verified" | "problems";
  daysChecked: number;
  mismatchedDays: number;
  mismatches: Record<string, unknown>[];
  overpaidOrders: number;
  statusMismatches: number;
  closedMonthDrift: number;
  details: { closedMonths?: Record<string, unknown>[] };
};

function toReconciliation(row: ReconciliationRow): ReconciliationEntity {
  return {
    id: row.id,
    kind: row.kind,
    requestedByName: row.requestedByName,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
    status: row.status,
    daysChecked: row.daysChecked,
    mismatchedDays: row.mismatchedDays,
    mismatches: row.mismatches.map(toMismatch),
    overpaidOrders: row.overpaidOrders,
    statusMismatches: row.statusMismatches,
    closedMonthDrift: row.closedMonthDrift,
    closedMonths: (row.details.closedMonths ?? []).map(toDrift),
  };
}

/**
 * Reads ledger_daily -- a few hundred small rows -- instead of every order and
 * payment. Range scans on its primary key (day). Closings are appended under
 * the month's exclusive advisory lock; the check is the ledger_reconcile()
 * database function (the nightly job runs the same one).
 */
export class DrizzleLedgerRepository implements LedgerRepositoryPort {
  async findMonths(months: string[]): Promise<LedgerMonthEntity[]> {
    if (months.length === 0) return [];
    const sorted = [...months].sort();
    const month = sql<string>`to_char(${ledgerDaily.day}, 'YYYY-MM')`;
    try {
      const rows = await db
        .select({ month, ...FIGURES })
        .from(ledgerDaily)
        .where(
          and(
            gte(ledgerDaily.day, monthStart(sorted[0]!)),
            lt(ledgerDaily.day, monthStart(addMonths(sorted.at(-1)!, 1))),
            inArray(month, months),
          ),
        )
        .groupBy(month);
      return rows.map((r) => ({ month: r.month, ...toFigures(r) }));
    } catch (error) {
      throw new InternalError("Failed to load the monthly ledger", error);
    }
  }

  async sumRange(fromDay: string, toDayExclusive: string): Promise<LedgerFigures> {
    try {
      const [row] = await db
        .select(FIGURES)
        .from(ledgerDaily)
        .where(and(gte(ledgerDaily.day, fromDay), lt(ledgerDaily.day, toDayExclusive)));
      return toFigures(row);
    } catch (error) {
      throw new InternalError("Failed to load the ledger totals", error);
    }
  }

  async findLatestClosings(months: string[]): Promise<LedgerClosingEntity[]> {
    if (months.length === 0) return [];
    try {
      // Latest per month: DISTINCT ON over the (month, created_at desc) index.
      const rows = await db
        .selectDistinctOn([ledgerMonthClosings.month], CLOSING_SELECT)
        .from(ledgerMonthClosings)
        .leftJoin(profiles, eq(profiles.id, ledgerMonthClosings.actorId))
        .where(inArray(ledgerMonthClosings.month, months.map(monthStart)))
        .orderBy(ledgerMonthClosings.month, desc(ledgerMonthClosings.createdAt), desc(ledgerMonthClosings.id));
      return rows.map(toClosing);
    } catch (error) {
      throw new InternalError("Failed to load the closed months", error);
    }
  }

  async listClosings(month: string, limit: number): Promise<{ items: LedgerClosingEntity[]; total: number }> {
    try {
      const rows = await db
        .select({ ...CLOSING_SELECT, total: sql<number>`(count(*) over ())::int` })
        .from(ledgerMonthClosings)
        .leftJoin(profiles, eq(profiles.id, ledgerMonthClosings.actorId))
        .where(eq(ledgerMonthClosings.month, monthStart(month)))
        .orderBy(desc(ledgerMonthClosings.createdAt), desc(ledgerMonthClosings.id))
        .limit(limit);
      return { items: rows.map(toClosing), total: rows[0]?.total ?? 0 };
    } catch (error) {
      throw new InternalError("Failed to load the month's closings", error);
    }
  }

  closeMonth(month: string, actorId: string, guard: MonthToggleGuard): Promise<LedgerClosingEntity> {
    return this.appendClosing(month, "closed", actorId, null, guard);
  }

  reopenMonth(month: string, actorId: string, reason: string, guard: MonthToggleGuard): Promise<LedgerClosingEntity> {
    return this.appendClosing(month, "reopened", actorId, reason, guard);
  }

  /**
   * One close or reopen, atomically: the month's EXCLUSIVE lock first -- it
   * waits for payment changes already in flight in the month to commit and
   * holds new ones off -- then the guard, then the row. Every statement after
   * the lock sees what committed before it was granted, so a close stores the
   * month's figures including the last payment that got in.
   */
  private async appendClosing(
    month: string,
    action: "closed" | "reopened",
    actorId: string,
    reason: string | null,
    guard: MonthToggleGuard,
  ): Promise<LedgerClosingEntity> {
    const day = monthStart(month);
    let id: string;
    try {
      id = await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${LEDGER_MONTH_LOCK_NAMESPACE}::int, public.ledger_month_key(${day}::date))`);
        const res = await tx.execute<{ closed: boolean }>(sql`select public.ledger_month_closed(${day}::date) as closed`);
        guard(res.rows[0]?.closed === true);

        let figures: Partial<typeof ledgerMonthClosings.$inferInsert> = {};
        if (action === "closed") {
          const [row] = await tx
            .select(FIGURES)
            .from(ledgerDaily)
            .where(and(gte(ledgerDaily.day, day), lt(ledgerDaily.day, monthStart(addMonths(month, 1)))));
          const f = toFigures(row);
          // Orders booked into the month take its lock too, so this count can't move now.
          assertAllPriced(f.ordersBooked, f.ordersPriced); // 409 LEDGER_MONTH_HAS_UNPRICED
          figures = {
            ordersBooked: f.ordersBooked,
            ordersPriced: f.ordersPriced,
            bookedTotal: f.total,
            paidOnBooked: f.paidSoFar,
            cashCollected: f.cashCollected,
            paymentsCount: f.paymentsCount,
          };
        }
        const [inserted] = await tx
          .insert(ledgerMonthClosings)
          .values({ month: day, action, ...figures, reason, actorId, requestId: getRequestContext()?.requestId ?? null })
          .returning({ id: ledgerMonthClosings.id });
        if (!inserted) throw new InternalError("The closing row wasn't written");
        return inserted.id;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new InternalError(action === "closed" ? "Failed to close the month" : "Failed to reopen the month", error);
    }

    const [closing] = await this.selectClosings(eq(ledgerMonthClosings.id, id));
    if (!closing) throw new InternalError("Failed to load the closing");
    return closing;
  }

  private async selectClosings(where: SQL): Promise<LedgerClosingEntity[]> {
    try {
      const rows = await db
        .select(CLOSING_SELECT)
        .from(ledgerMonthClosings)
        .leftJoin(profiles, eq(profiles.id, ledgerMonthClosings.actorId))
        .where(where);
      return rows.map(toClosing);
    } catch (error) {
      throw new InternalError("Failed to load the closing", error);
    }
  }

  async runReconciliation(requestedBy: string): Promise<ReconciliationEntity | null> {
    let id: string | null;
    try {
      const res = await db.execute<{ id: string | null }>(sql`select public.ledger_reconcile('manual', ${requestedBy}::uuid) as id`);
      id = res.rows[0]?.id ?? null;
    } catch (error) {
      throw new InternalError("Failed to run the ledger check", error);
    }
    if (id === null) return null; // another check is running

    try {
      const [row] = await db
        .select(RECONCILIATION_SELECT)
        .from(ledgerReconciliations)
        .leftJoin(profiles, eq(profiles.id, ledgerReconciliations.requestedBy))
        .where(eq(ledgerReconciliations.id, id));
      if (!row) throw new InternalError("The check's result wasn't found");
      return toReconciliation(row);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new InternalError("Failed to load the ledger check", error);
    }
  }

  async findLatestReconciliations(): Promise<{ latest: ReconciliationEntity | null; lastNightlyAt: string | null }> {
    try {
      const [latest, nightly] = await Promise.all([
        db
          .select(RECONCILIATION_SELECT)
          .from(ledgerReconciliations)
          .leftJoin(profiles, eq(profiles.id, ledgerReconciliations.requestedBy))
          .orderBy(desc(ledgerReconciliations.startedAt))
          .limit(1),
        db
          .select({ startedAt: ledgerReconciliations.startedAt })
          .from(ledgerReconciliations)
          .where(eq(ledgerReconciliations.kind, "nightly"))
          .orderBy(desc(ledgerReconciliations.startedAt))
          .limit(1),
      ]);
      return {
        latest: latest[0] ? toReconciliation(latest[0]) : null,
        lastNightlyAt: nightly[0]?.startedAt.toISOString() ?? null,
      };
    } catch (error) {
      throw new InternalError("Failed to load the ledger checks", error);
    }
  }
}
