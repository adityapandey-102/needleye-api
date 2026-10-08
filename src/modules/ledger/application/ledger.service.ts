import { businessToday } from "../../../common/time/business-date";
import { outstanding, toMoneyString } from "../../../common/money/money";
import {
  addMonths,
  assertExportable,
  assertMonthRange,
  monthCount,
  monthOf,
  monthsPage,
  monthStart,
} from "../domain/ledger-month.rules";
import type { LedgerRepositoryPort } from "./ports/ledger-repository.port";
import type { LedgerFigures, LedgerMonthEntity } from "../domain/ledger-month.entity";
import type {
  LedgerExportQuery,
  LedgerExportResponseDto,
  LedgerFiguresDto,
  LedgerMonthDto,
  LedgerMonthsQuery,
  LedgerMonthsResponseDto,
  LedgerSummaryResponseDto,
} from "../api/dto/ledger.dto";

export interface LedgerServiceOptions {
  /** The shop's IANA timezone -- which month "this month" is. */
  timeZone: string;
  /** Injectable clock, so "this month" is testable. */
  now?: () => Date;
}

const EMPTY: LedgerFigures = { ordersBooked: 0, ordersPriced: 0, total: "0.00", paidSoFar: "0.00", cashCollected: "0.00", paymentsCount: 0 };

export function toFiguresDto(f: LedgerFigures): LedgerFiguresDto {
  return {
    ordersBooked: f.ordersBooked,
    ordersNotPriced: f.ordersBooked - f.ordersPriced,
    total: f.total,
    paidSoFar: f.paidSoFar,
    outstanding: toMoneyString(outstanding(f.total, f.paidSoFar)),
    cashCollected: f.cashCollected,
    paymentsCount: f.paymentsCount,
  };
}

/**
 * The Revenue page's numbers (ADR 0008, phase 4), from ledger_daily: this
 * month's cards, and calendar months for any range -- paged, with the range's
 * totals summed by the API -- plus an unpaged export of a range. Owner and
 * Accountant (route-gated by reports:financial).
 */
export class LedgerService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: LedgerRepositoryPort,
    private readonly options: LedgerServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private today(): string {
    return businessToday(this.now(), this.options.timeZone);
  }

  async getSummary(): Promise<LedgerSummaryResponseDto> {
    const asOf = this.today();
    const month = monthOf(asOf);
    const figures = await this.repository.sumRange(monthStart(month), monthStart(addMonths(month, 1)));
    return { month, asOf, timeZone: this.options.timeZone, figures: toFiguresDto(figures) };
  }

  async getMonths(query: LedgerMonthsQuery): Promise<LedgerMonthsResponseDto> {
    const current = monthOf(this.today());
    const to = query.to ?? current;
    const from = query.from ?? `${to.slice(0, 4)}-01`;
    assertMonthRange(from, to, current);

    const page = monthsPage(from, to, query.offset, query.limit);
    const [found, totals] = await Promise.all([
      this.repository.findMonths(page),
      this.repository.sumRange(monthStart(from), monthStart(addMonths(to, 1))),
    ]);
    return {
      from,
      to,
      months: fillMonths(page, found),
      total: monthCount(from, to),
      limit: query.limit,
      offset: query.offset,
      totals: toFiguresDto(totals),
    };
  }

  async getExport(query: LedgerExportQuery): Promise<LedgerExportResponseDto> {
    assertMonthRange(query.from, query.to, monthOf(this.today()));
    assertExportable(query.from, query.to);
    const months = monthsPage(query.from, query.to, 0, monthCount(query.from, query.to));
    const [found, totals] = await Promise.all([
      this.repository.findMonths(months),
      this.repository.sumRange(monthStart(query.from), monthStart(addMonths(query.to, 1))),
    ]);
    return { from: query.from, to: query.to, timeZone: this.options.timeZone, months: fillMonths(months, found), totals: toFiguresDto(totals) };
  }
}

/** Every requested month, in the requested order -- a month with no activity reads as zeros. */
function fillMonths(months: string[], found: LedgerMonthEntity[]): LedgerMonthDto[] {
  const byMonth = new Map(found.map((m) => [m.month, m]));
  return months.map((month) => ({ month, ...toFiguresDto(byMonth.get(month) ?? EMPTY) }));
}
