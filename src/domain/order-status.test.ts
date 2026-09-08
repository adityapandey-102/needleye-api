import { describe, expect, it } from "vitest";
import {
  CANONICAL_TO_GRANULAR,
  DESIGN_STAGE_STATUSES,
  GRANULAR_STATUS_VALUES,
  PRODUCTION_STAGE_STATUSES,
  STAGE_CAPABILITY,
  STATUS_ALIASES,
  canonicalLabel,
  granularLabel,
  stageIndex,
  toCanonicalStage,
} from "./order-status";

describe("order status vocabularies", () => {
  it("maps every granular status to exactly one canonical stage (1:1)", () => {
    for (const status of GRANULAR_STATUS_VALUES) {
      expect(STATUS_ALIASES[status]).toBe(status);
    }
  });

  it("round-trips canonical->granular->canonical to the same stage", () => {
    for (const [canonical, granular] of Object.entries(CANONICAL_TO_GRANULAR)) {
      expect(toCanonicalStage(granular)).toBe(canonical);
    }
  });

  it("assigns every stage exactly one capability tier, and the tiers partition the flow", () => {
    for (const status of GRANULAR_STATUS_VALUES) {
      expect(STAGE_CAPABILITY[status]).toBeDefined();
    }
    const design = GRANULAR_STATUS_VALUES.filter((s) => STAGE_CAPABILITY[s] === "orders:status:design");
    const pmReceived = GRANULAR_STATUS_VALUES.filter((s) => STAGE_CAPABILITY[s] === "orders:status:pm_received");
    const production = GRANULAR_STATUS_VALUES.filter((s) => STAGE_CAPABILITY[s] === "orders:status:production");
    expect(design.length + pmReceived.length + production.length).toBe(GRANULAR_STATUS_VALUES.length);
    expect(design).toEqual(DESIGN_STAGE_STATUSES);
    expect(production).toEqual(PRODUCTION_STAGE_STATUSES);
    expect(pmReceived).toEqual(["production_manager_received"]);
  });

  it("orders the flow strictly forward (each stage's index is greater than the previous)", () => {
    for (let i = 1; i < GRANULAR_STATUS_VALUES.length; i++) {
      expect(stageIndex(GRANULAR_STATUS_VALUES[i]!)).toBeGreaterThan(stageIndex(GRANULAR_STATUS_VALUES[i - 1]!));
    }
  });

  it("returns human labels for known values and falls back to the raw value otherwise", () => {
    expect(granularLabel("design_pending")).toBe("Design Pending");
    expect(granularLabel("quality_check")).toBe("Quality Check / Trail");
    expect(canonicalLabel("delivered")).toBe("Delivered");
    // @ts-expect-error -- exercising the fallback branch with a value outside the known union
    expect(granularLabel("not_a_real_status")).toBe("not_a_real_status");
  });
});
