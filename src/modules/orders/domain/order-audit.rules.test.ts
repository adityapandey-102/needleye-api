import { describe, expect, it } from "vitest";
import { diffOrderFields } from "./order-audit.rules";

const before = {
  customerName: "Priya Sharma",
  phone: "9876543210",
  dueDate: "2026-10-20",
  nextPaymentDate: null,
  designerId: "d-1",
  handWork: false,
  designerInstructions: null,
  specialNotes: "",
};

describe("diffOrderFields (what an order edit changed)", () => {
  it("records each changed field with its before and after value", () => {
    expect(diffOrderFields(before, { dueDate: "2026-10-25", handWork: true, designerId: "d-2" })).toEqual({
      dueDate: { from: "2026-10-20", to: "2026-10-25" },
      designerId: { from: "d-1", to: "d-2" },
      handWork: { from: false, to: true },
    });
  });

  it("drops fields resent unchanged -- a save that changes nothing records nothing", () => {
    expect(diffOrderFields(before, { customerName: "Priya Sharma", phone: "9876543210", dueDate: "2026-10-20", handWork: false })).toEqual({});
  });

  it("treats blank text and null as the same nothing, and trims", () => {
    expect(diffOrderFields(before, { specialNotes: null, designerInstructions: "  ", customerName: " Priya Sharma " })).toEqual({});
    expect(diffOrderFields(before, { specialNotes: "Rush order" })).toEqual({ specialNotes: { from: null, to: "Rush order" } });
    expect(diffOrderFields(before, { nextPaymentDate: "2026-11-01" })).toEqual({ nextPaymentDate: { from: null, to: "2026-11-01" } });
  });

  it("only looks at the audited order fields", () => {
    expect(diffOrderFields(before, { updatedBy: "x", version: 3 } as never)).toEqual({});
  });
});
