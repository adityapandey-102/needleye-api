import { describe, expect, it, vi } from "vitest";
import { LedgerService } from "./ledger.service";
import type { LedgerRepositoryPort, MonthToggleGuard } from "./ports/ledger-repository.port";
import type { LedgerClosingEntity, ReconciliationEntity } from "../domain/ledger-closing.entity";
import { ERROR_CODES } from "../../../common/errors/error-codes";

const figures = { ordersBooked: 3, ordersPriced: 2, total: "30000.00", paidSoFar: "12000.00", cashCollected: "9000.00", paymentsCount: 4 };

const closedSep: LedgerClosingEntity = {
  id: "c1",
  month: "2026-09",
  action: "closed",
  figures,
  reason: null,
  actorName: "Owner",
  createdAt: "2026-10-02T05:00:00.000Z",
};

const check: ReconciliationEntity = {
  id: "r1",
  kind: "manual",
  requestedByName: "Owner",
  startedAt: "2026-10-31T19:59:59.000Z",
  finishedAt: "2026-10-31T19:59:59.250Z",
  status: "verified",
  daysChecked: 400,
  mismatchedDays: 0,
  mismatches: [],
  overpaidOrders: 0,
  statusMismatches: 0,
  closedMonthDrift: 0,
  closedMonths: [],
};

function repo(opts: { closedNow?: boolean; checkRunning?: boolean } = {}) {
  const findMonths = vi.fn().mockResolvedValue([{ month: "2026-09", ...figures }]);
  const sumRange = vi.fn().mockResolvedValue(figures);
  const findLatestClosings = vi.fn().mockResolvedValue([closedSep]);
  const listClosings = vi.fn().mockResolvedValue({ items: [closedSep], total: 1 });
  // The repository runs the guard under the month's lock with the month's state at that moment.
  const closeMonth = vi.fn((month: string, _actor: string, guard: MonthToggleGuard) =>
    Promise.resolve().then(() => {
      guard(opts.closedNow ?? false);
      return { ...closedSep, month };
    }),
  );
  const reopenMonth = vi.fn((month: string, _actor: string, reason: string, guard: MonthToggleGuard) =>
    Promise.resolve().then(() => {
      guard(opts.closedNow ?? true);
      return { ...closedSep, month, action: "reopened" as const, figures: null, reason };
    }),
  );
  const runReconciliation = vi.fn().mockResolvedValue(opts.checkRunning ? null : check);
  const findLatestReconciliations = vi.fn().mockResolvedValue({ latest: check, lastNightlyAt: "2026-10-30T20:30:00.000Z" });
  const port: LedgerRepositoryPort = {
    findMonths,
    sumRange,
    findLatestClosings,
    listClosings,
    closeMonth,
    reopenMonth,
    runReconciliation,
    findLatestReconciliations,
  };
  return { port, findMonths, sumRange, findLatestClosings, listClosings, closeMonth, reopenMonth, runReconciliation };
}

// 2026-10-31 20:00 UTC = 1 Nov 01:30 in Kolkata -- "this month" is the SHOP's month.
const svc = (r: ReturnType<typeof repo>) => new LedgerService(r.port, { timeZone: "Asia/Kolkata", now: () => new Date("2026-10-31T20:00:00Z") });

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (error) {
    return (error as { code: string }).code;
  }
  return undefined;
}

describe("LedgerService", () => {
  it("summary: this month in the shop's timezone, with outstanding and not-priced derived", async () => {
    const r = repo();
    const out = await svc(r).getSummary();
    expect(r.sumRange).toHaveBeenCalledWith("2026-11-01", "2026-12-01");
    expect(out).toMatchObject({ month: "2026-11", asOf: "2026-11-01", timeZone: "Asia/Kolkata" });
    expect(out.figures).toEqual({
      ordersBooked: 3,
      ordersNotPriced: 1,
      total: "30000.00",
      paidSoFar: "12000.00",
      outstanding: "18000.00",
      cashCollected: "9000.00",
      paymentsCount: 4,
    });
  });

  it("months: defaults to this year so far, newest first, months without activity read as zeros", async () => {
    const r = repo();
    const out = await svc(r).getMonths({ limit: 3, offset: 1 });
    expect(out).toMatchObject({ from: "2026-01", to: "2026-11", total: 11, limit: 3, offset: 1 });
    expect(r.findMonths).toHaveBeenCalledWith(["2026-10", "2026-09", "2026-08"]);
    expect(out.months.map((m) => [m.month, m.total])).toEqual([
      ["2026-10", "0.00"],
      ["2026-09", "30000.00"],
      ["2026-08", "0.00"],
    ]);
    expect(r.sumRange).toHaveBeenCalledWith("2026-01-01", "2026-12-01");
    expect(out.totals.outstanding).toBe("18000.00");
  });

  it("months: each month's books -- closed by its latest close, ended once it's over", async () => {
    const r = repo();
    const out = await svc(r).getMonths({ from: "2026-09", to: "2026-11", limit: 12, offset: 0 });
    expect(r.findLatestClosings).toHaveBeenCalledWith(["2026-11", "2026-10", "2026-09"]);
    expect(out.months.map((m) => [m.month, m.books])).toEqual([
      ["2026-11", { status: "open", ended: false, closedAt: null, closedByName: null }],
      ["2026-10", { status: "open", ended: true, closedAt: null, closedByName: null }],
      ["2026-09", { status: "closed", ended: true, closedAt: "2026-10-02T05:00:00.000Z", closedByName: "Owner" }],
    ]);
  });

  it("export: every month of the range; refuses a range past this month or over 240 months", async () => {
    const r = repo();
    const out = await svc(r).getExport({ from: "2026-07", to: "2026-09" });
    expect(out.months.map((m) => m.month)).toEqual(["2026-09", "2026-08", "2026-07"]);
    expect(out.months[0]!.books.status).toBe("closed");
    await expect(svc(r).getExport({ from: "2026-07", to: "2026-12" })).rejects.toThrow(/Pick months/);
    await expect(svc(r).getExport({ from: "2005-01", to: "2026-01" })).rejects.toThrow(/at most 240 months/);
  });

  it("close: only a finished month, and only when it's open (checked under the lock)", async () => {
    const r = repo();
    const closing = await svc(r).closeMonth("2026-10", "u1");
    expect(closing).toMatchObject({ month: "2026-10", action: "closed" });
    expect(closing.figures?.outstanding).toBe("18000.00");

    // November is this month in the shop's timezone -- still running.
    expect(await codeOf(svc(repo()).closeMonth("2026-11", "u1"))).toBe(ERROR_CODES.LEDGER_MONTH_NOT_FINISHED);
    expect(await codeOf(svc(repo({ closedNow: true })).closeMonth("2026-09", "u1"))).toBe(ERROR_CODES.LEDGER_MONTH_ALREADY_CLOSED);
    expect(await codeOf(svc(repo()).closeMonth("2026-9", "u1"))).toBe(ERROR_CODES.LEDGER_MONTHS_RANGE_INVALID);
  });

  it("reopen: needs a reason, and a closed month", async () => {
    const r = repo();
    const out = await svc(r).reopenMonth("2026-09", "u1", "  CA found a cash entry dated wrong ");
    expect(r.reopenMonth).toHaveBeenCalledWith("2026-09", "u1", "CA found a cash entry dated wrong", expect.any(Function));
    expect(out).toMatchObject({ action: "reopened", figures: null, reason: "CA found a cash entry dated wrong" });

    expect(await codeOf(svc(repo()).reopenMonth("2026-09", "u1", "no"))).toBe(ERROR_CODES.LEDGER_REOPEN_REASON_REQUIRED);
    expect(await codeOf(svc(repo({ closedNow: false })).reopenMonth("2026-09", "u1", "fix it"))).toBe(ERROR_CODES.LEDGER_MONTH_NOT_CLOSED);
  });

  it("closings: the month's figures now, its books, and the history", async () => {
    const r = repo();
    const out = await svc(r).getClosings("2026-09");
    expect(r.listClosings).toHaveBeenCalledWith("2026-09", 50);
    expect(out.books).toMatchObject({ status: "closed", ended: true });
    expect(out.figuresNow.total).toBe("30000.00");
    expect(out.history).toHaveLength(1);
    expect(out.total).toBe(1);
  });

  it("verify now: runs the check; 409 while another is running; nightly overdue after 26h", async () => {
    const out = await svc(repo()).verifyNow("u1");
    expect(out.latest).toMatchObject({ id: "r1", status: "verified", durationMs: 250 });
    expect(out.lastNightlyAt).toBe("2026-10-30T20:30:00.000Z");
    expect(out.nightlyOverdue).toBe(false); // 23.5 hours ago

    expect(await codeOf(svc(repo({ checkRunning: true })).verifyNow("u1"))).toBe(ERROR_CODES.LEDGER_CHECK_RUNNING);

    const later = new LedgerService(repo().port, { timeZone: "Asia/Kolkata", now: () => new Date("2026-11-01T00:00:00Z") });
    expect((await later.getVerification()).nightlyOverdue).toBe(true); // 27.5 hours
  });
});
