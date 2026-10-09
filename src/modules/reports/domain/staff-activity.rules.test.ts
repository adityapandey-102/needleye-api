import { describe, expect, it } from "vitest";
import {
  activityDays,
  assertActivityDay,
  businessToday,
  staffStatus,
  workingWindowHours,
} from "./staff-activity.rules";

describe("staff activity rules", () => {
  it("windows (owner, 2026-10-09): 30 days for designers, 24 hours for everyone on the floor", () => {
    expect(workingWindowHours("designer")).toBe(30 * 24);
    expect(workingWindowHours("master_tailor")).toBe(24);
    expect(workingWindowHours("production_manager")).toBe(24);
    expect(workingWindowHours("worker")).toBe(24);
  });

  it("Working iff at least one qualifying undelivered order", () => {
    expect(staffStatus(0)).toBe("idle");
    expect(staffStatus(1)).toBe("working");
  });

  it("'today' is the shop's date, not UTC's: 20:00 UTC is already tomorrow in India", () => {
    const lateEvening = new Date("2026-09-24T20:00:00Z"); // 01:30 on the 25th in Kolkata
    expect(businessToday(lateEvening, "Asia/Kolkata")).toBe("2026-09-25");
    expect(businessToday(lateEvening, "UTC")).toBe("2026-09-24");
  });

  it("the feed covers today and the 6 days before it, newest first, across a month end", () => {
    expect(activityDays("2026-10-02")).toEqual([
      "2026-10-02",
      "2026-10-01",
      "2026-09-30",
      "2026-09-29",
      "2026-09-28",
      "2026-09-27",
      "2026-09-26",
    ]);
    expect(activityDays("2028-03-01")).toContain("2028-02-29"); // leap day
  });

  it("refuses a day outside the 7-day window (and the future)", () => {
    expect(() => assertActivityDay("2026-09-18", "2026-09-24")).not.toThrow();
    expect(() => assertActivityDay("2026-09-17", "2026-09-24")).toThrow(/last 7 days/);
    expect(() => assertActivityDay("2026-09-25", "2026-09-24")).toThrow(/last 7 days/);
  });
});
