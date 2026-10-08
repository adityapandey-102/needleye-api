import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { createApp } from "../../src/app";
import { orders } from "../../src/modules/orders/infrastructure/order.schema";
import { env } from "../../src/config/env";
import { db } from "../../src/common/database/drizzle-client";
import { orderAuditLog } from "../../src/modules/orders/infrastructure/order-audit-log.schema";
import { authProvider } from "../../src/common/auth/supabase-auth-provider";
import {
  DELIVERY_DAY_LOCK_NAMESPACE,
  DrizzleOrdersRepository,
} from "../../src/modules/orders/infrastructure/drizzle-orders.repository";
import type { NewOrderRecord } from "../../src/modules/orders/application/ports/orders-repository.port";
import { createFixtureUser, deleteFixtureOrder, deleteFixtureUser, closeDb, type FixtureUser } from "./helpers";

/**
 * Delivery-day capacity (DELIVERY_DAY_CAPACITY, default 10), end to end over
 * HTTP against the real database: the load endpoint, the 409 on a full day, the
 * audited Production-Manager override, the edit rules, and the race for a day's
 * last slot. Every test books its own random far-future date, so none of them
 * depend on (or disturb) whatever else is in the database.
 */
describe("delivery-day capacity (integration)", () => {
  const app = createApp();
  const repo = new DrizzleOrdersRepository();
  const capacity = env.DELIVERY_DAY_CAPACITY;
  const createdOrderIds: string[] = [];
  let designerA: FixtureUser;
  let designerB: FixtureUser;
  let master: FixtureUser;
  let authA: string;
  let authMaster: string;

  /** A random date in 2031-2040 -- collision-free in practice, and never "today". */
  function uniqueDate(): string {
    const day = Math.floor(Math.random() * 3650);
    return new Date(Date.UTC(2031, 0, 1) + day * 86_400_000).toISOString().slice(0, 10);
  }

  function record(dueDate: string, designerId = designerA.id): NewOrderRecord {
    return {
      customerName: "Capacity Test",
      phone: "9000000000",
      billNumber: `CAP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      bookingDate: "2026-01-01",
      dueDate,
      nextPaymentDate: null,
      designerId,
      masterTailorId: master.id,
      productCategory: "saree",
      orderDetails: "Delivery capacity fixture",
      handWork: false,
      machineWork: false,
      purchaseRequired: false,
      paymentStatus: "unpaid",
      totalAmount: "1000.00",
      productionStatus: "design_pending",
      designerInstructions: null,
      specialNotes: null,
      createdBy: designerId,
      updatedBy: designerId,
    };
  }

  /** Puts `n` orders on `dueDate` directly through the repository (no capacity guard) -- test setup only. */
  async function fillDay(dueDate: string, n: number, designerId?: string): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const entity = await repo.create(record(dueDate, designerId));
      ids.push(entity.id);
      createdOrderIds.push(entity.id);
    }
    return ids;
  }

  function createBody(dueDate: string, extra: Record<string, unknown> = {}) {
    return {
      customerName: "Capacity HTTP",
      phone: "9000000001",
      billNumber: `CAPH-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      dueDate,
      designerId: designerA.id,
      masterTailorId: master.id,
      productCategory: "saree",
      orderDetails: "via HTTP",
      totalAmount: "1000.00",
      productionStatus: "design_pending",
      ...extra,
    };
  }

  async function post(dueDate: string, extra: Record<string, unknown> = {}) {
    const res = await request(app).post("/api/v1/orders").set("Authorization", authA).send(createBody(dueDate, extra));
    const id = (res.body as { order?: { id: string } }).order?.id;
    if (id) createdOrderIds.push(id);
    return res;
  }

  async function countOn(dueDate: string): Promise<number> {
    const days = await repo.countOrdersDueByDay({ from: dueDate, to: dueDate });
    return days[0]?.count ?? 0;
  }

  /** The order's log rows that record a full-day override (logged with the create / edit itself, ADR 0008). */
  async function overrideAudits(orderId: string) {
    return db
      .select()
      .from(orderAuditLog)
      .where(and(eq(orderAuditLog.orderId, orderId), sql`${orderAuditLog.details} ? 'deliveryOverride'`));
  }

  beforeAll(async () => {
    designerA = await createFixtureUser("designer", "Capacity Designer A");
    designerB = await createFixtureUser("designer", "Capacity Designer B");
    master = await createFixtureUser("master_tailor", "Capacity Master");
    authA = `Bearer ${(await authProvider.signInWithPassword(designerA.email, designerA.password)).accessToken}`;
    authMaster = `Bearer ${(await authProvider.signInWithPassword(master.email, master.password)).accessToken}`;
  });

  afterAll(async () => {
    for (const id of createdOrderIds) await deleteFixtureOrder(id);
    for (const u of [designerA, designerB, master]) if (u) await deleteFixtureUser(u.id);
    await closeDb();
  });

  it("GET /orders/delivery-load counts EVERY order on a day, shop-wide -- not just the caller's", async () => {
    const day = uniqueDate();
    // Designer B's orders: designer A can't see these orders, but must see the day's load.
    const [firstB] = await fillDay(day, 3, designerB.id);

    const res = await request(app)
      .get("/api/v1/orders/delivery-load")
      .query({ from: day, to: day })
      .set("Authorization", authA);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ capacity, nearCapacity: Math.ceil(capacity * 0.8), days: [{ date: day, count: 3 }] });

    // excludeOrderId leaves the order being edited out of its own day's count.
    const excluded = await request(app)
      .get("/api/v1/orders/delivery-load")
      .query({ from: day, to: day, excludeOrderId: firstB })
      .set("Authorization", authA);
    expect((excluded.body as { days: { count: number }[] }).days[0]?.count).toBe(2);
  });

  it("rejects a malformed or oversized range with 400, and a role that can't pick due dates with 403", async () => {
    const get = (query: Record<string, string>, auth = authA) =>
      request(app).get("/api/v1/orders/delivery-load").query(query).set("Authorization", auth);
    expect((await get({ from: "2031-02-31", to: "2031-03-01" })).status).toBe(400); // not a real date
    expect((await get({ from: "2031-05-10", to: "2031-05-01" })).status).toBe(400); // backwards
    expect((await get({ from: "2031-01-01", to: "2031-12-31" })).status).toBe(400); // > 200 days
    expect((await get({ from: "2031-01-01", to: "2031-01-31" }, authMaster)).status).toBe(403);
  });

  it("refuses a full day with 409 DELIVERY_DAY_FULL -- then books it with the PM confirmation, audited", async () => {
    const day = uniqueDate();
    await fillDay(day, capacity);

    const refused = await post(day);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "DELIVERY_DAY_FULL", details: { dueDate: day, booked: capacity, capacity } });
    expect(await countOn(day)).toBe(capacity); // nothing written

    const allowed = await post(day, { confirmedWithProductionManager: true });
    expect(allowed.status).toBe(201);
    const orderId = (allowed.body as { order: { id: string } }).order.id;
    expect(await countOn(day)).toBe(capacity + 1);

    const audits = await overrideAudits(orderId);
    expect(audits).toHaveLength(1);
    expect(audits[0]?.details?.deliveryOverride).toMatchObject({ dueDate: day, bookedBefore: capacity, capacity });
  });

  it("does not record an override when the confirmation was sent for a day that had room", async () => {
    const day = uniqueDate();
    const res = await post(day, { confirmedWithProductionManager: true });
    expect(res.status).toBe(201);
    expect(await overrideAudits((res.body as { order: { id: string } }).order.id)).toHaveLength(0);
  });

  it("edits: keeping a full day's date is never blocked; moving an order ONTO a full day is", async () => {
    const full = uniqueDate();
    const [onFullDay] = await fillDay(full, capacity);
    const [elsewhere] = await fillDay(uniqueDate(), 1);

    // The edit form resends every field, date included -- must not be blocked.
    const keep = await request(app)
      .patch(`/api/v1/orders/${onFullDay}`)
      .set("Authorization", authA)
      .send({ customerName: "Renamed On A Full Day", dueDate: full });
    expect(keep.status).toBe(200);

    const move = await request(app).patch(`/api/v1/orders/${elsewhere}`).set("Authorization", authA).send({ dueDate: full });
    expect(move.status).toBe(409);
    expect((move.body as { code: string }).code).toBe("DELIVERY_DAY_FULL");

    const moveConfirmed = await request(app)
      .patch(`/api/v1/orders/${elsewhere}`)
      .set("Authorization", authA)
      .send({ dueDate: full, confirmedWithProductionManager: true });
    expect(moveConfirmed.status).toBe(200);
    expect(await overrideAudits(elsewhere!)).toHaveLength(1);
  });

  it("race for the LAST slot: a booking waits for one already in progress, then sees the day full", async () => {
    // Deterministic, not two parallel requests: those rarely truly overlap (each
    // one's auth call staggers them), so a naive race test passes even with the
    // lock removed -- it did, when checked. Instead, another booking is held
    // IN PROGRESS: a transaction takes the same per-day lock, inserts the last
    // slot, and waits before committing. A real booking arriving meanwhile must
    // block on the lock, then count the committed slot -> 409. Without the lock
    // it would read the stale 9-of-10, succeed, and the day would end at 11.
    const day = uniqueDate();
    await fillDay(day, capacity - 1);

    let lockTaken!: () => void;
    const lockHeld = new Promise<void>((resolve) => (lockTaken = resolve));
    const inProgress = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${DELIVERY_DAY_LOCK_NAMESPACE}::int, hashtext(${day}::text))`);
      const [row] = await tx
        .insert(orders)
        .values({ ...record(day), orderNumber: "", totalAmount: "1000.00" })
        .returning({ id: orders.id });
      if (row) createdOrderIds.push(row.id);
      lockTaken();
      await new Promise((resolve) => setTimeout(resolve, 1500)); // hold the lock, uncommitted
    });

    await lockHeld;
    const res = await post(day); // must wait ~1.5s for the in-progress booking to commit
    await inProgress;

    expect(res.status).toBe(409);
    expect(await countOn(day)).toBe(capacity);
  });
});
