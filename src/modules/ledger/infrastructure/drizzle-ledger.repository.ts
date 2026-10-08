import { and, gte, inArray, lt, sql } from "drizzle-orm";
import { db } from "../../../common/database/drizzle-client";
import { InternalError } from "../../../common/errors/app-error";
import { toMoneyString } from "../../../common/money/money";
import { ledgerDaily } from "./ledger.schema";
import { addMonths, monthStart } from "../domain/ledger-month.rules";
import type { LedgerRepositoryPort } from "../application/ports/ledger-repository.port";
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

/**
 * Reads ledger_daily -- a few hundred small rows -- instead of every order and
 * payment. Range scans on its primary key (day).
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
}
