import { describe, expect, it, vi } from "vitest";
import { ReportsService } from "./reports.service";
import type { ReportsRepositoryPort } from "./ports/reports-repository.port";

/** A stub repository plus direct handles on its mocks (so assertions never touch unbound methods). */
function repo(workload: unknown[] = []) {
  const getStaffWorkload = vi.fn().mockResolvedValue({ rows: workload, total: workload.length, counts: { working: 1, idle: 1 } });
  const getActivityDay = vi.fn().mockResolvedValue([]);
  const getActivityCounts = vi.fn().mockResolvedValue({ orders: 3, stages: 5, payments: 1, leads: 0, accounts: 2 });
  const port: ReportsRepositoryPort = { getStaffWorkload, getActivityDay, getActivityCounts };
  return { port, getStaffWorkload, getActivityDay, getActivityCounts };
}

const at = (iso: string) => () => new Date(iso);

describe("ReportsService", () => {
  it("derives Working / Idle from the open-order count, with the agreed windows", async () => {
    const r = repo([
      { id: "a", fullName: "A", role: "designer", openOrders: 2, lastWorkAt: "x", lastSeenAt: null },
      { id: "b", fullName: "B", role: "worker", openOrders: 0, lastWorkAt: null, lastSeenAt: null },
    ]);
    const out = await new ReportsService(r.port, { timeZone: "Asia/Kolkata" }).getStaffActivity({ q: "an", role: "worker", status: "idle", limit: 20, offset: 40 });
    expect(r.getStaffWorkload).toHaveBeenCalledWith({
      designerWindowDays: 30,
      floorWindowHours: 24,
      search: "an",
      role: "worker",
      status: "idle",
      limit: 20,
      offset: 40,
    });
    expect(out).toMatchObject({ total: 2, limit: 20, offset: 40, counts: { working: 1, idle: 1 } });
    expect(out.windows).toEqual({ designerDays: 30, floorHours: 24 });
    expect(out.staff.map((s) => s.status)).toEqual(["working", "idle"]);
  });

  it("lists the 7 activity days in the shop's timezone", () => {
    const svc = new ReportsService(repo().port, { timeZone: "Asia/Kolkata", now: at("2026-09-24T19:00:00Z") });
    const days = svc.getActivityDays();
    expect(days.today).toBe("2026-09-25"); // 00:30 IST
    expect(days.days).toHaveLength(7);
    expect(days.days.at(-1)).toBe("2026-09-19");
  });

  it("loads one category of one day with every category's count, and refuses days outside the window", async () => {
    const r = repo();
    const svc = new ReportsService(r.port, { timeZone: "Asia/Kolkata", now: at("2026-09-24T06:00:00Z") });
    const out = await svc.getActivityDay({ day: "2026-09-20", category: "stages", limit: 50, offset: 0 });
    expect(r.getActivityDay).toHaveBeenCalledWith({ day: "2026-09-20", timeZone: "Asia/Kolkata", category: "stages", limit: 50, offset: 0 });
    expect(r.getActivityCounts).toHaveBeenCalledWith("2026-09-20", "Asia/Kolkata");
    expect(out).toMatchObject({ category: "stages", total: 5, counts: { orders: 3, stages: 5, payments: 1, leads: 0, accounts: 2 } });
    await expect(svc.getActivityDay({ day: "2026-09-10", category: "orders", limit: 50, offset: 0 })).rejects.toThrow(/last 7 days/);
    expect(r.getActivityDay).toHaveBeenCalledTimes(1);
  });
});
