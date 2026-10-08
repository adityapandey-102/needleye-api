import { describe, expect, it, vi } from "vitest";
import { LedgerService } from "./ledger.service";
import type { LedgerRepositoryPort } from "./ports/ledger-repository.port";

const figures = { ordersBooked: 3, ordersPriced: 2, total: "30000.00", paidSoFar: "12000.00", cashCollected: "9000.00", paymentsCount: 4 };

function repo() {
  const findMonths = vi.fn().mockResolvedValue([{ month: "2026-09", ...figures }]);
  const sumRange = vi.fn().mockResolvedValue(figures);
  const port: LedgerRepositoryPort = { findMonths, sumRange };
  return { port, findMonths, sumRange };
}

// 2026-10-31 20:00 UTC = 1 Nov 01:30 in Kolkata -- "this month" is the SHOP's month.
const svc = (r: ReturnType<typeof repo>) => new LedgerService(r.port, { timeZone: "Asia/Kolkata", now: () => new Date("2026-10-31T20:00:00Z") });

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

  it("export: every month of the range; refuses a range past this month or over 240 months", async () => {
    const r = repo();
    const out = await svc(r).getExport({ from: "2026-07", to: "2026-09" });
    expect(out.months.map((m) => m.month)).toEqual(["2026-09", "2026-08", "2026-07"]);
    await expect(svc(r).getExport({ from: "2026-07", to: "2026-12" })).rejects.toThrow(/Pick months/);
    await expect(svc(r).getExport({ from: "2005-01", to: "2026-01" })).rejects.toThrow(/at most 240 months/);
  });
});
