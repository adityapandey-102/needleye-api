import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DrizzleOrdersRepository } from "../../src/modules/orders/infrastructure/drizzle-orders.repository";
import { sql } from "drizzle-orm";
import { db } from "../../src/common/database/drizzle-client";
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
      nextPaymentDate: null,
      designerId: designer.id,
      masterTailorId: masterTailor.id,
      productCategory: "saree",
      orderDetails: "Integration test order",
      handWork: false,
      machineWork: true,
      purchaseRequired: false,
      paymentStatus: "advance_paid",
      totalAmount: "1000.00",
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

  it("order numbers past 999 keep every digit: ORD-YYYY-1234, not a truncated, colliding -123 (migration 20260925000003)", async () => {
    // Inside a transaction that is always rolled back, so the real counter is untouched.
    const rollback = new Error("rollback");
    let numbers: string[] = [];
    await db
      .transaction(async (tx) => {
        await tx.execute(sql`
          insert into order_counters (year, next_seq) values (extract(year from now())::int, 1234)
          on conflict (year) do update set next_seq = 1234`);
        for (let i = 0; i < 2; i++) {
          const res = await tx.execute<{ order_number: string }>(sql`
            insert into orders (order_number, customer_name, phone, bill_number, due_date, designer_id, master_tailor_id,
                                product_category, order_details, payment_status)
            values ('', 'Numbering', '9000000000', ${`NUM-${Date.now()}-${i}`}, '2039-01-01', ${designer.id}, ${masterTailor.id},
                    'saree', 'numbering', 'unpaid')
            returning order_number`);
          numbers.push(res.rows[0]!.order_number);
        }
        throw rollback;
      })
      .catch((e: unknown) => {
        if (e !== rollback) throw e;
      });
    const year = new Date().getFullYear();
    expect(numbers).toEqual([`ORD-${year}-1234`, `ORD-${year}-1235`]);
    numbers = [];
  });

  it("createdFrom keeps only orders created on or after that shop day (the Kanban's 2-month window), and the total agrees", async () => {
    const recent = await repo.create(baseOrder());
    const old = await repo.create(baseOrder());
    createdOrderIds.push(recent.id, old.id);
    // Push one order 70 days into the past.
    await db.execute(sql`update orders set created_at = now() - interval '70 days' where id = ${old.id}`);

    const sixtyDaysAgo = new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10);
    const scope = { role: "designer" as const, userId: designer.id };
    const filters = { createdFrom: sixtyDaysAgo };
    const page = await repo.findMany(scope, filters, { limit: 50, offset: 0 });
    const ids = page.map((o) => o.id);
    expect(ids).toContain(recent.id);
    expect(ids).not.toContain(old.id);
    expect(await repo.countMany(scope, filters)).toBe(page.length);
    // Without the window both are there.
    const all = (await repo.findMany(scope, {}, { limit: 50, offset: 0 })).map((o) => o.id);
    expect(all).toEqual(expect.arrayContaining([recent.id, old.id]));
  });

  it("dueOn lists exactly the orders due that day (the delivery calendar's day list), and the total agrees", async () => {
    const day = "2038-03-17";
    const onDay = await repo.create(baseOrder({ dueDate: day }));
    const dayAfter = await repo.create(baseOrder({ dueDate: "2038-03-18" }));
    createdOrderIds.push(onDay.id, dayAfter.id);
    const scope = { role: "owner_manager" as const, userId: designer.id };
    const page = await repo.findMany(scope, { dueOn: day }, { limit: 50, offset: 0 });
    expect(page.map((o) => o.id)).toContain(onDay.id);
    expect(page.map((o) => o.id)).not.toContain(dayAfter.id);
    expect(page.every((o) => o.dueDate === day)).toBe(true);
    expect(await repo.countMany(scope, { dueOn: day })).toBe(page.length);
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

  it("the database accepts the new catalogue categories (migration 20260924000002 drops the CHECK)", async () => {
    // A new womenswear category, a prefixed men's one, and a kids' one. Without
    // the migration, the original 5-value CHECK rejects all three with a 23514.
    for (const productCategory of ["anarkali", "mens_shirt", "kids_boys_custom"] as const) {
      const entity = await repo.create(baseOrder({ productCategory }));
      createdOrderIds.push(entity.id);
      expect(entity.productCategory).toBe(productCategory);
    }
  });

  it("the database accepts the Dyeing stage in both CHECK constraints (migration 20260924000001)", async () => {
    const entity = await repo.create(baseOrder());
    createdOrderIds.push(entity.id);

    // Fabric Purchased -> Dyeing -> Cutting: the new stage in its place in the
    // flow. updateStatus writes BOTH orders.production_status and an
    // order_status_history row, so a success here proves both constraints allow
    // 'dyeing' -- without the migration this throws a 23514 check violation.
    await repo.updateStatus(entity.id, "fabric_purchased", designer.id);
    const dyed = await repo.updateStatus(entity.id, "dyeing", designer.id);
    expect(dyed.productionStatus).toBe("dyeing");
    await repo.updateStatus(entity.id, "cutting", designer.id);

    const history = await repo.listStatusHistory(entity.id);
    expect(history.map((h) => h.status).slice(0, 3)).toEqual(["cutting", "dyeing", "fabric_purchased"]);
    expect(history.find((h) => h.status === "dyeing")?.label).toBe("Dyeing");
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
