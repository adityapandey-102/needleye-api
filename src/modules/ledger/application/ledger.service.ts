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
import { assertCanToggle, assertClosable, assertMonthParam, normalizeReopenReason } from "../domain/ledger-closing.rules";
import { assertCheckRan, isNightlyOverdue } from "../domain/reconciliation.rules";
import type { LedgerRepositoryPort } from "./ports/ledger-repository.port";
import type { LedgerFigures, LedgerMonthEntity } from "../domain/ledger-month.entity";
import type { LedgerClosingEntity, ReconciliationEntity } from "../domain/ledger-closing.entity";
import type {
  LedgerClosingDto,
  LedgerExportQuery,
  LedgerExportResponseDto,
  LedgerFiguresDto,
  LedgerMonthBooksDto,
  LedgerMonthClosingsResponseDto,
  LedgerMonthDto,
  LedgerMonthsQuery,
  LedgerMonthsResponseDto,
  LedgerSummaryResponseDto,
  LedgerVerificationResponseDto,
  ReconciliationDto,
} from "../api/dto/ledger.dto";

export interface LedgerServiceOptions {
  /** The shop's IANA timezone -- which month "this month" is. */
  timeZone: string;
  /** Injectable clock, so "this month" is testable. */
  now?: () => Date;
}

/** A month's close/reopen history shown at once (it's a handful in practice). */
export const CLOSINGS_HISTORY_MAX = 50;

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

function toClosingDto(c: LedgerClosingEntity): LedgerClosingDto {
  return { ...c, figures: c.figures ? toFiguresDto(c.figures) : null };
}

function toReconciliationDto(r: ReconciliationEntity): ReconciliationDto {
  return { ...r, durationMs: Date.parse(r.finishedAt) - Date.parse(r.startedAt) };
}

/** A month's books from its latest close/reopen: closed when that was a close. */
function booksOf(month: string, latest: LedgerClosingEntity | undefined, currentMonth: string): LedgerMonthBooksDto {
  const closed = latest?.action === "closed";
  return {
    status: closed ? "closed" : "open",
    ended: month < currentMonth,
    closedAt: closed ? latest.createdAt : null,
    closedByName: closed ? latest.actorName : null,
  };
}

/**
 * The Revenue page's numbers (ADR 0008, phases 4-5), from ledger_daily: this
 * month's cards, and calendar months for any range -- paged, with the range's
 * totals summed by the API -- plus an unpaged export of a range. Closing the
 * books (a finished month; Owner/Accountant) and reopening them (Owner, with
 * a reason), and the check that the register matches the receipts. Routes
 * gate who may call what.
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

  private currentMonth(): string {
    return monthOf(this.today());
  }

  async getSummary(): Promise<LedgerSummaryResponseDto> {
    const asOf = this.today();
    const month = monthOf(asOf);
    const figures = await this.repository.sumRange(monthStart(month), monthStart(addMonths(month, 1)));
    return { month, asOf, timeZone: this.options.timeZone, figures: toFiguresDto(figures) };
  }

  async getMonths(query: LedgerMonthsQuery): Promise<LedgerMonthsResponseDto> {
    const current = this.currentMonth();
    const to = query.to ?? current;
    const from = query.from ?? `${to.slice(0, 4)}-01`;
    assertMonthRange(from, to, current);

    const page = monthsPage(from, to, query.offset, query.limit);
    const [found, totals, closings] = await Promise.all([
      this.repository.findMonths(page),
      this.repository.sumRange(monthStart(from), monthStart(addMonths(to, 1))),
      this.repository.findLatestClosings(page),
    ]);
    return {
      from,
      to,
      months: fillMonths(page, found, closings, current),
      total: monthCount(from, to),
      limit: query.limit,
      offset: query.offset,
      totals: toFiguresDto(totals),
    };
  }

  async getExport(query: LedgerExportQuery): Promise<LedgerExportResponseDto> {
    const current = this.currentMonth();
    assertMonthRange(query.from, query.to, current);
    assertExportable(query.from, query.to);
    const months = monthsPage(query.from, query.to, 0, monthCount(query.from, query.to));
    const [found, totals, closings] = await Promise.all([
      this.repository.findMonths(months),
      this.repository.sumRange(monthStart(query.from), monthStart(addMonths(query.to, 1))),
      this.repository.findLatestClosings(months),
    ]);
    return {
      from: query.from,
      to: query.to,
      timeZone: this.options.timeZone,
      months: fillMonths(months, found, closings, current),
      totals: toFiguresDto(totals),
    };
  }

  /** A month's books: its figures now, and every close and reopen (the closing record is the latest close's figures). */
  async getClosings(month: string): Promise<LedgerMonthClosingsResponseDto> {
    assertMonthParam(month);
    const [found, history] = await Promise.all([
      this.repository.findMonths([month]),
      this.repository.listClosings(month, CLOSINGS_HISTORY_MAX),
    ]);
    return {
      month,
      books: booksOf(month, history.items[0], this.currentMonth()),
      figuresNow: toFiguresDto(found[0] ?? EMPTY),
      history: history.items.map(toClosingDto),
      total: history.total,
    };
  }

  /** Closes a finished month's books, keeping its figures as they are now. */
  async closeMonth(month: string, actorId: string): Promise<LedgerClosingDto> {
    assertClosable(month, this.currentMonth());
    const closing = await this.repository.closeMonth(month, actorId, (isClosed) => assertCanToggle("close", isClosed));
    return toClosingDto(closing);
  }

  /** Reopens a closed month -- with a reason, which is kept. */
  async reopenMonth(month: string, actorId: string, reason: string | undefined): Promise<LedgerClosingDto> {
    assertMonthParam(month);
    const why = normalizeReopenReason(reason);
    const closing = await this.repository.reopenMonth(month, actorId, why, (isClosed) => assertCanToggle("reopen", isClosed));
    return toClosingDto(closing);
  }

  /** The latest check, and whether the nightly one is on schedule. */
  async getVerification(): Promise<LedgerVerificationResponseDto> {
    const { latest, lastNightlyAt } = await this.repository.findLatestReconciliations();
    return this.toVerification(latest, lastNightlyAt);
  }

  /** "Verify now": the same check the nightly job runs. */
  async verifyNow(actorId: string): Promise<LedgerVerificationResponseDto> {
    const run = await this.repository.runReconciliation(actorId);
    assertCheckRan(run); // 409 while another check is running
    const { lastNightlyAt } = await this.repository.findLatestReconciliations();
    return this.toVerification(run, lastNightlyAt);
  }

  private toVerification(latest: ReconciliationEntity | null, lastNightlyAt: string | null): LedgerVerificationResponseDto {
    return {
      timeZone: this.options.timeZone,
      latest: latest ? toReconciliationDto(latest) : null,
      lastNightlyAt,
      nightlyOverdue: isNightlyOverdue(lastNightlyAt, this.now()),
    };
  }
}

/** Every requested month, in the requested order -- a month with no activity reads as zeros. */
function fillMonths(months: string[], found: LedgerMonthEntity[], closings: LedgerClosingEntity[], currentMonth: string): LedgerMonthDto[] {
  const byMonth = new Map(found.map((m) => [m.month, m]));
  const closingByMonth = new Map(closings.map((c) => [c.month, c]));
  return months.map((month) => ({
    month,
    ...toFiguresDto(byMonth.get(month) ?? EMPTY),
    books: booksOf(month, closingByMonth.get(month), currentMonth),
  }));
}
