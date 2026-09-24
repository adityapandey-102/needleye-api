import { describe, expect, it } from "vitest";
import { checkDeliveryDayCapacity, deliveryLoadLevel, nearCapacityThreshold } from "./delivery-capacity.rules";
import { ConflictError } from "../../../common/errors/app-error";

describe("deliveryLoadLevel (calendar colour)", () => {
  it("with capacity 10: 0-7 open (blue), 8-9 filling (amber), 10+ full (red)", () => {
    expect(nearCapacityThreshold(10)).toBe(8);
    for (const n of [0, 5, 7]) expect(deliveryLoadLevel(n, 10)).toBe("open");
    for (const n of [8, 9]) expect(deliveryLoadLevel(n, 10)).toBe("filling");
    for (const n of [10, 11, 25]) expect(deliveryLoadLevel(n, 10)).toBe("full");
  });

  it("never lets the near threshold drop to 0 for a tiny capacity", () => {
    expect(nearCapacityThreshold(1)).toBe(1);
    expect(deliveryLoadLevel(0, 1)).toBe("open");
  });
});

describe("checkDeliveryDayCapacity", () => {
  const base = { dueDate: "2031-05-01", previousDueDate: null, capacity: 10, confirmedWithProductionManager: false };

  it("allows a day with room, with no override recorded", () => {
    expect(checkDeliveryDayCapacity({ ...base, booked: 9 })).toEqual({ overridden: false });
  });

  it("refuses a full day (10 of 10 already booked) with 409 DELIVERY_DAY_FULL and the numbers", () => {
    try {
      checkDeliveryDayCapacity({ ...base, booked: 10 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConflictError);
      const err = e as ConflictError;
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe("DELIVERY_DAY_FULL");
      expect(err.details).toEqual({ dueDate: "2031-05-01", booked: 10, capacity: 10 });
    }
  });

  it("books a full day when confirmed with the Production Manager -- and reports it as an override", () => {
    expect(checkDeliveryDayCapacity({ ...base, booked: 12, confirmedWithProductionManager: true })).toEqual({
      overridden: true,
    });
  });

  it("does NOT count a confirmation on a day with room as an override (nothing to audit)", () => {
    expect(checkDeliveryDayCapacity({ ...base, booked: 3, confirmedWithProductionManager: true })).toEqual({
      overridden: false,
    });
  });

  it("never checks an edit that keeps the same date, even on an over-full day", () => {
    // The edit form resends every field; fixing a name on an order already
    // booked onto a full day (by override) must not be blocked.
    expect(checkDeliveryDayCapacity({ ...base, previousDueDate: "2031-05-01", booked: 15 })).toEqual({
      overridden: false,
    });
  });

  it("does check an edit that MOVES the order onto a full day", () => {
    expect(() => checkDeliveryDayCapacity({ ...base, previousDueDate: "2031-04-20", booked: 10 })).toThrow(ConflictError);
  });
});
