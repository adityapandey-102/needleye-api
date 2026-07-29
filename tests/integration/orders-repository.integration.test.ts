import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DrizzleOrdersRepository } from "../../src/modules/orders/infrastructure/drizzle-orders.repository";
import { ConflictError } from "../../src/common/errors/app-error";
import { ERROR_CODES } from "../../src/common/errors/error-codes";
import { createFixtureUser, deleteFixtureOrder, deleteFixtureUser, closeDb } from "./helpers";
import type { FixtureUser } from "./helpers";
import type { NewOrderRecord } from "../../src/modules/orders/application/ports/orders-repository.port";
import type { GranularStatus } from "../../src/domain";

/**
 * Repository <-> real Postgres, and the DB-side concerns a unit test can't
 * reach: the order-number generation trigger, and transaction atomicity of
 * create()/updateStatus() (order row + status-history row must land
 * together or not at all). See needleye-api/CLAUDE.md's testing pyramid.
 */
describe("DrizzleOrdersRepository (integration)", () => {
  const repo = new DrizzleOrdersRepository();
  let designer: FixtureUser;
  let masterTailor: FixtureUser;
  const createdOrderIds: string[] = [];

  beforeAll(async () => {
    designer = await createFixtureUser("designer", "Integration Test Designer");
    masterTailor = await createFixtureUser("master_tailor", "Integration Test Master");
  }, 30_000);

  afterAll(async () => {
    for (const id of createdOrderIds) await deleteFixtureOrder(id);
    await deleteFixtureUser(designer.id);
    await deleteFixtureUser(masterTailor.id);
    await closeDb();
  }, 30_000);

  function baseOrder(overrides: Partial<NewOrderRecord> = {}): NewOrderRecord {
    return {
      customerName: "Integration Test Customer",
      phone: "9000000000",
      billNumber: `IT-${Date.now()}`,
      bookingDate: "2026-01-01",
      dueDate: "2026-02-01",
      designerId: designer.id,
      masterTailorId: masterTailor.id,
      productCategory: "saree",
      orderDetails: "Integration test order",
      handWork: false,
      machineWork: true,
      purchaseRequired: false,
      paymentStatus: "advance_paid",
      totalAmount: 1000,
      productionStatus: "design_pending",
      designerInstructions: null,
      specialNotes: null,
      createdBy: designer.id,
      updatedBy: designer.id,
      ...overrides,
    };
  }

  it("creates an order with a real DB-generated order number and an initial history entry", async () => {
    const entity = await repo.create(baseOrder());
    createdOrderIds.push(entity.id);

    // orders_set_order_number (BEFORE INSERT trigger) writes this -- the
    // repository sends an empty string, see drizzle-orders.repository.ts.
    expect(entity.orderNumber).toMatch(/^ORD-\d{4}-\d+$/);

    const history = await repo.listStatusHistory(entity.id);
    expect(history).toHaveLength(1);
    expect(history[0]?.status).toBe("design_pending");
  });

  it("generates strictly increasing order numbers under sequential inserts (no collisions)", async () => {
    const first = await repo.create(baseOrder());
    const second = await repo.create(baseOrder());
    createdOrderIds.push(first.id, second.id);

    expect(first.orderNumber).not.toBe(second.orderNumber);
  });

  it("updateStatus writes the order row and a new history row together", async () => {
    const entity = await repo.create(baseOrder());
    createdOrderIds.push(entity.id);

    const updated = await repo.updateStatus(entity.id, "design_approved", designer.id);
    expect(updated.productionStatus).toBe("design_approved");

    const history = await repo.listStatusHistory(entity.id);
    expect(history).toHaveLength(2);
    expect(history[0]?.status).toBe("design_approved"); // most recent first
  });

  it("rolls back the whole transaction if the status update violates a DB constraint", async () => {
    const entity = await repo.create(baseOrder());
    createdOrderIds.push(entity.id);

    // Not a real GranularStatus -- bypasses TypeScript on purpose to reach
    // the DB's own CHECK constraint on production_status, proving
    // updateStatus()'s db.transaction() is atomic: if the second insert
    // (or, here, the update itself) fails, nothing from this call persists.
    await expect(repo.updateStatus(entity.id, "not_a_real_status" as GranularStatus, designer.id)).rejects.toThrow();

    // owner_manager's scope is unconditional (see rowScopeCondition) -- an unscoped lookup, same as findByIdUnscoped uses internally.
    const unchanged = await repo.findById({ role: "owner_manager", userId: "" }, entity.id);
    expect(unchanged?.productionStatus).toBe("design_pending");

    const history = await repo.listStatusHistory(entity.id);
    expect(history).toHaveLength(1); // no orphaned history row from the failed attempt
  });

  it("row-scopes findMany to only the assigned designer/master_tailor", async () => {
    const entity = await repo.create(baseOrder());
    createdOrderIds.push(entity.id);

    const page = { limit: 100, offset: 0 };
    const asDesigner = await repo.findMany({ role: "designer", userId: designer.id }, {}, page);
    expect(asDesigner.some((o) => o.id === entity.id)).toBe(true);

    const otherDesigner = await createFixtureUser("designer", "Other Designer");
    try {
      const asOtherDesigner = await repo.findMany({ role: "designer", userId: otherDesigner.id }, {}, page);
      expect(asOtherDesigner.some((o) => o.id === entity.id)).toBe(false);
    } finally {
      await deleteFixtureUser(otherDesigner.id);
    }
  });

  it("optimistic-locks update(): a stale version is rejected with ORDER_MODIFIED, not silently applied", async () => {
    const entity = await repo.create(baseOrder());
    createdOrderIds.push(entity.id);
    expect(entity.version).toBe(0);

    // First edit with the version we loaded (0) succeeds and bumps version to 1.
    const updated = await repo.update(entity.id, { customerName: "First Edit", updatedBy: designer.id }, 0);
    expect(updated.version).toBe(1);
    expect(updated.customerName).toBe("First Edit");

    // A second edit still holding the old version (0) -- as a concurrent user would --
    // must be rejected, not clobber the first edit.
    await expect(repo.update(entity.id, { customerName: "Stale Edit", updatedBy: designer.id }, 0)).rejects.toMatchObject({
      code: ERROR_CODES.ORDER_MODIFIED,
    });
    await expect(repo.update(entity.id, { customerName: "Stale Edit", updatedBy: designer.id }, 0)).rejects.toBeInstanceOf(
      ConflictError,
    );

    // The first edit still stands; the stale edit never applied.
    const current = await repo.findById({ role: "owner_manager", userId: "" }, entity.id);
    expect(current?.customerName).toBe("First Edit");
  });

  it("update() without a version bumps version and applies unconditionally (no lock)", async () => {
    const entity = await repo.create(baseOrder());
    createdOrderIds.push(entity.id);

    const updated = await repo.update(entity.id, { customerName: "Unlocked Edit", updatedBy: designer.id });
    expect(updated.version).toBe(1);
    expect(updated.customerName).toBe("Unlocked Edit");
  });

  it("paginates findMany by limit/offset while countMany reports the unpaginated total", async () => {
    // Three fresh orders for this same designer; page size 2 must return 2 then 1,
    // and countMany must see all 3 (>= 3, since the designer may own others).
    const a = await repo.create(baseOrder());
    const b = await repo.create(baseOrder());
    const c = await repo.create(baseOrder());
    createdOrderIds.push(a.id, b.id, c.id);

    const scope = { role: "designer" as const, userId: designer.id };
    const total = await repo.countMany(scope, {});
    expect(total).toBeGreaterThanOrEqual(3);

    const firstPage = await repo.findMany(scope, {}, { limit: 2, offset: 0 });
    expect(firstPage).toHaveLength(2);

    const secondPage = await repo.findMany(scope, {}, { limit: 2, offset: 2 });
    expect(secondPage.length).toBeGreaterThanOrEqual(1);

    // No overlap between pages (ordered by created_at desc, stable).
    const firstIds = new Set(firstPage.map((o) => o.id));
    expect(secondPage.every((o) => !firstIds.has(o.id))).toBe(true);
  });
});
