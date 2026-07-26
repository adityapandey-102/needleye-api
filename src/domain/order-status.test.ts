import { describe, expect, it } from "vitest";
import {
  CANONICAL_TO_GRANULAR,
  DESIGN_STAGE_STATUSES,
  GRANULAR_STATUS_VALUES,
  PRODUCTION_STAGE_STATUSES,
  STATUS_ALIASES,
  canonicalLabel,
  granularLabel,
  toCanonicalStage,
} from "./order-status";

describe("order status vocabularies", () => {
  it("maps every granular status to exactly one canonical stage", () => {
    for (const status of GRANULAR_STATUS_VALUES) {
      expect(STATUS_ALIASES[status]).toBeDefined();
    }
  });

  it("round-trips canonical->granular->canonical to the same stage", () => {
    for (const [canonical, granular] of Object.entries(CANONICAL_TO_GRANULAR)) {
      expect(toCanonicalStage(granular)).toBe(canonical);
    }
  });

  it("partitions design-stage and production-stage statuses with no overlap", () => {
    const overlap = DESIGN_STAGE_STATUSES.filter((s) => PRODUCTION_STAGE_STATUSES.includes(s));
    expect(overlap).toEqual([]);
    expect(DESIGN_STAGE_STATUSES.length + PRODUCTION_STAGE_STATUSES.length).toBe(GRANULAR_STATUS_VALUES.length);
  });

  it("collapses finishing and quality_check into the same qc column", () => {
    expect(toCanonicalStage("finishing")).toBe("qc");
    expect(toCanonicalStage("quality_check")).toBe("qc");
  });

  it("returns human labels for known values and falls back to the raw value otherwise", () => {
    expect(granularLabel("design_pending")).toBe("Design Pending");
    expect(canonicalLabel("qc")).toBe("QC");
    // @ts-expect-error -- exercising the fallback branch with a value outside the known union
    expect(granularLabel("not_a_real_status")).toBe("not_a_real_status");
  });
});
