import { describe, expect, it } from "vitest";
import {
  CANONICAL_TO_GRANULAR,
  DESIGN_STAGE_STATUSES,
  GRANULAR_STATUS_VALUES,
  PIPELINE_GROUPS,
  PIPELINE_STAGE_GROUPS,
  PRODUCTION_STAGE_STATUSES,
  STAGE_CAPABILITY,
  STATUS_ALIASES,
  canonicalLabel,
  granularLabel,
  nextMainStage,
  stageIndex,
  stageMoveRefusal,
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
    const finalization = GRANULAR_STATUS_VALUES.filter((s) => STAGE_CAPABILITY[s] === "orders:status:finalization");
    expect(design.length + pmReceived.length + production.length + finalization.length).toBe(
      GRANULAR_STATUS_VALUES.length,
    );
    expect(design).toEqual(DESIGN_STAGE_STATUSES);
    expect(pmReceived).toEqual(["production_manager_received"]);
    expect(finalization).toEqual(["quality_check", "alteration", "ready", "delivered"]);
  });

  it("places Dyeing then Marking between Fabric Purchased and Cutting, in the production tier", () => {
    expect(GRANULAR_STATUS_VALUES).toHaveLength(16);
    expect(stageIndex("dyeing")).toBe(stageIndex("fabric_purchased") + 1);
    expect(stageIndex("marking")).toBe(stageIndex("dyeing") + 1);
    expect(stageIndex("cutting")).toBe(stageIndex("marking") + 1);
    expect(STAGE_CAPABILITY.marking).toBe("orders:status:production");
    expect(granularLabel("marking")).toBe("Marking");
    expect(STAGE_CAPABILITY.dyeing).toBe("orders:status:production");
    expect(granularLabel("dyeing")).toBe("Dyeing");
    expect(PRODUCTION_STAGE_STATUSES).toContain("dyeing");
  });

  it("keeps the in-production REPORTING grouping independent of the permission tiers", () => {
    // PRODUCTION_STAGE_STATUSES backs the dashboard's "In Production" count. The
    // finalization tier split QC / Alteration / Delivered off the production tier
    // for PERMISSIONS only -- the reporting grouping must still span Falls/Kutchu
    // through Delivered, or QC and Alteration silently drop out of that count.
    expect(PRODUCTION_STAGE_STATUSES[0]).toBe("falls_kutchu");
    expect(PRODUCTION_STAGE_STATUSES.at(-1)).toBe("delivered");
    expect(PRODUCTION_STAGE_STATUSES).toContain("quality_check");
    expect(PRODUCTION_STAGE_STATUSES).toContain("alteration");
    expect(PRODUCTION_STAGE_STATUSES).not.toContain("production_manager_received");
  });

  it("places Ready right before Delivered, after Alteration, in the finalization tier", () => {
    expect(GRANULAR_STATUS_VALUES.slice(-4)).toEqual(["quality_check", "alteration", "ready", "delivered"]);
    expect(STAGE_CAPABILITY.ready).toBe("orders:status:finalization");
    expect(granularLabel("ready")).toBe("Ready");
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

describe("stageMoveRefusal (the flow's shape, ADR 0008)", () => {
  it("allows ordinary forward moves, including skips", () => {
    expect(stageMoveRefusal("design_pending", "design_approved")).toBeNull();
    expect(stageMoveRefusal("dyeing", "marking")).toBeNull();
    expect(stageMoveRefusal("stitching", "finishing")).toBeNull();
    expect(stageMoveRefusal("quality_check", "ready")).toBeNull();
    expect(stageMoveRefusal("quality_check", "alteration")).toBeNull();
    expect(stageMoveRefusal("finishing", "ready")).toBeNull();
  });

  it("refuses the same stage (repeat scan / concurrent double-advance)", () => {
    expect(stageMoveRefusal("cutting", "cutting")).toBe("same_stage");
    expect(stageMoveRefusal("ready", "ready")).toBe("same_stage");
    expect(stageMoveRefusal("delivered", "delivered")).toBe("same_stage");
  });

  it("allows Delivered only from Ready", () => {
    expect(stageMoveRefusal("ready", "delivered")).toBeNull();
    for (const from of GRANULAR_STATUS_VALUES.filter((s) => s !== "ready" && s !== "delivered")) {
      expect(stageMoveRefusal(from, "delivered")).toBe("deliver_requires_ready");
    }
  });

  it("allows the alteration loop: Ready -> Alteration -> Ready", () => {
    expect(stageMoveRefusal("ready", "alteration")).toBeNull();
    expect(stageMoveRefusal("alteration", "ready")).toBeNull();
  });

  it("refuses every other backward move", () => {
    expect(stageMoveRefusal("cutting", "marking")).toBe("backward");
    expect(stageMoveRefusal("ready", "quality_check")).toBe("backward");
    expect(stageMoveRefusal("alteration", "quality_check")).toBe("backward");
    expect(stageMoveRefusal("delivered", "alteration")).toBe("backward");
    expect(stageMoveRefusal("delivered", "ready")).toBe("backward");
  });
});

describe("nextMainStage (what a scan advances to)", () => {
  it("walks the main path and never suggests Alteration", () => {
    expect(nextMainStage("dyeing")).toBe("marking");
    expect(nextMainStage("marking")).toBe("cutting");
    expect(nextMainStage("finishing")).toBe("quality_check");
    expect(nextMainStage("quality_check")).toBe("ready");
    expect(nextMainStage("alteration")).toBe("ready");
    expect(nextMainStage("ready")).toBe("delivered");
    expect(nextMainStage("delivered")).toBeNull();
  });

  it("every suggestion is a move the flow allows", () => {
    for (const from of GRANULAR_STATUS_VALUES) {
      const next = nextMainStage(from);
      if (next) expect(stageMoveRefusal(from, next)).toBeNull();
    }
  });
});

describe("the dashboard pipeline", () => {
  it("puts every stage except Delivered in exactly one group, in flow order", () => {
    const grouped = PIPELINE_GROUPS.flatMap((g) => PIPELINE_STAGE_GROUPS[g]);
    expect(grouped).toEqual(GRANULAR_STATUS_VALUES.filter((s) => s !== "delivered"));
    expect(PIPELINE_STAGE_GROUPS.checks).toEqual(["quality_check", "alteration"]);
    expect(PIPELINE_STAGE_GROUPS.ready).toEqual(["ready"]);
  });
});
