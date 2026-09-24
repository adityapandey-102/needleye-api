import { describe, expect, it } from "vitest";
import { businessToday, monthStartMonthsBack } from "./business-date";

describe("businessToday", () => {
  it("is the shop's date, not UTC's: 00:30 IST on the 1st is still the 1st (UTC says the 30th)", () => {
    const halfPastMidnightIst = new Date("2026-09-30T19:00:00Z"); // 00:30 on 1 Oct in Kolkata
    expect(halfPastMidnightIst.toISOString().slice(0, 10)).toBe("2026-09-30"); // the old, wrong answer
    expect(businessToday(halfPastMidnightIst, "Asia/Kolkata")).toBe("2026-10-01");
  });

  it("agrees with UTC once both are past midnight", () => {
    expect(businessToday(new Date("2026-10-01T10:00:00Z"), "Asia/Kolkata")).toBe("2026-10-01");
  });

  it("handles the year boundary", () => {
    expect(businessToday(new Date("2026-12-31T20:00:00Z"), "Asia/Kolkata")).toBe("2027-01-01");
  });
});

describe("monthStartMonthsBack", () => {
  it("steps back whole months across a year boundary", () => {
    expect(monthStartMonthsBack("2026-09-25", 11)).toBe("2025-10-01");
    expect(monthStartMonthsBack("2026-01-31", 1)).toBe("2025-12-01");
    expect(monthStartMonthsBack("2026-03-15", 0)).toBe("2026-03-01");
  });
});
