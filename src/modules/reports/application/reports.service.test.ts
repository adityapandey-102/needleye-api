import { describe, expect, it, vi } from "vitest";
import { ReportsService } from "./reports.service";
import type { ReportsRepositoryPort } from "./ports/reports-repository.port";

/** A stub repository plus direct handles on its mocks (so assertions never touch unbound methods). */
function repo(workload: unknown[] = []) {
  const getStaffWorkload = vi.fn().mockResolvedValue({ rows: workload, total: workload.length, counts: { working: 1, idle: 1 } });
  const getActivityDay = vi.fn().mockResolvedValue({ events: [], total: 0 });
  const port: ReportsRepositoryPort = { getStaffWorkload, getActivityDay };
  return { port, getStaffWorkload, getActivityDay };
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
      designerWindowDays: 45,
      floorWindowDays: 30,
      search: "an",
      role: "worker",
      status: "idle",
      limit: 20,
      offset: 40,
    });
    expect(out).toMatchObject({ total: 2, limit: 20, offset: 40, counts: { working: 1, idle: 1 } });
    expect(out.windows).toEqual({ designerDays: 45, floorDays: 30 });
    expect(out.staff.map((s) => s.status)).toEqual(["working", "idle"]);
  });

  it("lists the 7 activity days in the shop's timezone", () => {
    const svc = new ReportsService(repo().port, { timeZone: "Asia/Kolkata", now: at("2026-09-24T19:00:00Z") });
    const days = svc.getActivityDays();
    expect(days.today).toBe("2026-09-25"); // 00:30 IST
    expect(days.days).toHaveLength(7);
    expect(days.days.at(-1)).toBe("2026-09-19");
  });

  it("loads one day with payment events excluded, and refuses days outside the window", async () => {
    const r = repo();
    const svc = new ReportsService(r.port, { timeZone: "Asia/Kolkata", now: at("2026-09-24T06:00:00Z") });
    await svc.getActivityDay({ day: "2026-09-20", limit: 50, offset: 0 });
    expect(r.getActivityDay).toHaveBeenCalledWith({
      day: "2026-09-20",
      timeZone: "Asia/Kolkata",
      excludePrefixes: ["payment."],
      limit: 50,
      offset: 0,
    });
    await expect(svc.getActivityDay({ day: "2026-09-10", limit: 50, offset: 0 })).rejects.toThrow(/last 7 days/);
    expect(r.getActivityDay).toHaveBeenCalledTimes(1);
  });
});
