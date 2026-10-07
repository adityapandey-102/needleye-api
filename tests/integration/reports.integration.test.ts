import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { createApp } from "../../src/app";
import { db } from "../../src/common/database/drizzle-client";
import { auditLog } from "../../src/common/audit/audit-log.schema";
import { authProvider } from "../../src/common/auth/supabase-auth-provider";
import { orders } from "../../src/modules/orders/infrastructure/order.schema";
import { orderStatusHistory } from "../../src/modules/orders/infrastructure/order-status-history.schema";
import { DrizzleOrdersRepository } from "../../src/modules/orders/infrastructure/drizzle-orders.repository";
import { DrizzleReportsRepository } from "../../src/modules/reports/infrastructure/drizzle-reports.repository";
import type { NewOrderRecord } from "../../src/modules/orders/application/ports/orders-repository.port";
import { createFixtureUser, deleteFixtureOrder, deleteFixtureUser, closeDb, type FixtureUser } from "./helpers";

/**
 * Batch E's owner Reports, against the real database: the Working / Idle rules
 * (designer = created an undelivered order in 45 days; floor = made the latest
 * stage move on an undelivered order in 30 days), the activity feed's
 * shop-timezone day boundaries and payment exclusion, and owner-only access.
 */
describe("owner reports (integration)", () => {
  const app = createApp();
  const ordersRepo = new DrizzleOrdersRepository();
  const reportsRepo = new DrizzleReportsRepository();
  const orderIds: string[] = [];
  const auditIds: string[] = [];
  let owner: FixtureUser;
  let designer: FixtureUser;
  let master: FixtureUser;
  let workerA: FixtureUser;
  let workerB: FixtureUser;
  let ownerAuth: string;
  let designerAuth: string;

  function record(): NewOrderRecord {
    return {
      customerName: "Reports Test",
      phone: "9000000000",
      billNumber: `REP-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      bookingDate: "2026-01-01",
      dueDate: "2039-06-15",
      nextPaymentDate: null,
      designerId: designer.id,
      masterTailorId: master.id,
      productCategory: "saree",
      orderDetails: "Reports fixture",
      handWork: false,
      machineWork: false,
      purchaseRequired: false,
      paymentStatus: "unpaid",
      totalAmount: "1000.00",
      productionStatus: "design_pending",
      designerInstructions: null,
      specialNotes: null,
      createdBy: designer.id,
      updatedBy: designer.id,
    };
  }

  async function newOrder(): Promise<string> {
    const entity = await ordersRepo.create(record());
    orderIds.push(entity.id);
    return entity.id;
  }

  const WINDOWS = { designerWindowDays: 45, floorWindowDays: 30 };

  /** The fixture's row, found by searching its (unique) name -- also exercises the search. */
  async function row(user: FixtureUser) {
    const page = await reportsRepo.getStaffWorkload({ ...WINDOWS, search: nameOf.get(user.id), limit: 50, offset: 0 });
    return page.rows.find((r) => r.id === user.id);
  }
  const nameOf = new Map<string, string>();
  const tag = Math.random().toString(36).slice(2, 8);
  async function staff(role: FixtureUser["role"], name: string) {
    const fullName = `${name} ${tag}`;
    const u = await createFixtureUser(role, fullName);
    nameOf.set(u.id, fullName);
    return u;
  }

  beforeAll(async () => {
    owner = await createFixtureUser("owner_manager", "Reports Owner");
    designer = await staff("designer", "Reports Designer");
    master = await staff("master_tailor", "Reports Master");
    workerA = await staff("worker", "Reports Worker A");
    workerB = await staff("worker", "Reports Worker B");
    ownerAuth = `Bearer ${(await authProvider.signInWithPassword(owner.email, owner.password)).accessToken}`;
    designerAuth = `Bearer ${(await authProvider.signInWithPassword(designer.email, designer.password)).accessToken}`;
  });

  afterAll(async () => {
    if (auditIds.length) await db.delete(auditLog).where(inArray(auditLog.id, auditIds));
    for (const id of orderIds) await deleteFixtureOrder(id);
    for (const u of [owner, designer, master, workerA, workerB]) if (u) await deleteFixtureUser(u.id);
    await closeDb();
  });

  /** Delivered only follows Ready (the database enforces it), so go through Ready first. */
  async function deliver(id: string) {
    await db.update(orders).set({ productionStatus: "ready" }).where(eq(orders.id, id));
    await db.update(orders).set({ productionStatus: "delivered" }).where(eq(orders.id, id));
  }

  it("a designer is Working while an order they created is undelivered, Idle once it's delivered", async () => {
    expect((await row(designer))?.openOrders).toBe(0);
    const id = await newOrder();
    expect(await row(designer)).toMatchObject({ openOrders: 1, role: "designer" });
    await deliver(id);
    expect((await row(designer))?.openOrders).toBe(0);
  });

  it("an order created more than 45 days ago no longer makes its designer Working", async () => {
    const id = await newOrder();
    expect((await row(designer))?.openOrders).toBe(1);
    await db.update(orders).set({ createdAt: new Date(Date.now() - 46 * 86_400_000) }).where(eq(orders.id, id));
    expect((await row(designer))?.openOrders).toBe(0);
    await deliver(id);
  });

  it("the floor: whoever made the LATEST move holds the order; a later move by someone else passes it on", async () => {
    const id = await newOrder();
    await ordersRepo.updateStatus(id, "cutting", workerA.id);
    expect((await row(workerA))?.openOrders).toBe(1);
    expect((await row(workerB))?.openOrders).toBe(0);

    await ordersRepo.updateStatus(id, "stitching", workerB.id);
    expect((await row(workerA))?.openOrders).toBe(0);
    expect(await row(workerB)).toMatchObject({ openOrders: 1 });

    // A move older than 30 days doesn't count.
    await db
      .update(orderStatusHistory)
      .set({ createdAt: new Date(Date.now() - 31 * 86_400_000) })
      .where(eq(orderStatusHistory.orderId, id));
    expect((await row(workerB))?.openOrders).toBe(0);
  });

  it("the owner and accountant are never listed", async () => {
    const page = await reportsRepo.getStaffWorkload({ ...WINDOWS, limit: 50, offset: 0 });
    expect(page.rows.find((r) => r.id === owner.id)).toBeUndefined();
    expect(page.rows.every((r) => ["designer", "master_tailor", "production_manager", "worker"].includes(r.role))).toBe(true);
  });

  it("search, role and status filter in the database; pages add up; counts ignore the status filter", async () => {
    const q = tag; // matches exactly this file's 4 staff fixtures
    const all = await reportsRepo.getStaffWorkload({ ...WINDOWS, search: q, limit: 50, offset: 0 });
    expect(all.total).toBe(4);
    expect(all.counts.working + all.counts.idle).toBe(4);

    const p1 = await reportsRepo.getStaffWorkload({ ...WINDOWS, search: q, limit: 3, offset: 0 });
    const p2 = await reportsRepo.getStaffWorkload({ ...WINDOWS, search: q, limit: 3, offset: 3 });
    expect(p1.rows).toHaveLength(3);
    expect(p2.rows).toHaveLength(1);
    expect(new Set([...p1.rows, ...p2.rows].map((r) => r.id)).size).toBe(4);
    expect(p2.total).toBe(4);

    const workers = await reportsRepo.getStaffWorkload({ ...WINDOWS, search: q, role: "worker", limit: 50, offset: 0 });
    expect(workers.rows.map((r) => r.role)).toEqual(["worker", "worker"]);

    const idle = await reportsRepo.getStaffWorkload({ ...WINDOWS, search: q, status: "idle", limit: 50, offset: 0 });
    expect(idle.rows.every((r) => r.openOrders === 0)).toBe(true);
    expect(idle.counts).toEqual(all.counts);

    // Past the end: no rows, but the real total and counts.
    const past = await reportsRepo.getStaffWorkload({ ...WINDOWS, search: q, limit: 3, offset: 30 });
    expect(past.rows).toHaveLength(0);
    expect(past.total).toBe(4);

    // LIKE wildcards in the search are literal.
    const pct = await reportsRepo.getStaffWorkload({ ...WINDOWS, search: "%", limit: 50, offset: 0 });
    expect(pct.rows.find((r) => r.id === designer.id)).toBeUndefined();
  });

  it("activity days run midnight-to-midnight in the SHOP's timezone, and payment events are left out", async () => {
    // 2026-09-20 in Kolkata = 2026-09-19T18:30Z .. 2026-09-20T18:30Z.
    const inserted = await db
      .insert(auditLog)
      .values([
        { actorId: workerA.id, action: "order.status_changed", entityType: "order", createdAt: new Date("2026-09-19T18:30:00Z") }, // 00:00 IST on the 20th
        { actorId: workerA.id, action: "order.status_changed", entityType: "order", createdAt: new Date("2026-09-20T18:29:59Z") }, // 23:59:59 IST on the 20th
        { actorId: workerA.id, action: "order.status_changed", entityType: "order", createdAt: new Date("2026-09-19T18:29:59Z") }, // 23:59:59 IST on the 19th
        { actorId: workerA.id, action: "payment.created", entityType: "payment", createdAt: new Date("2026-09-20T06:00:00Z") },
      ])
      .returning({ id: auditLog.id });
    auditIds.push(...inserted.map((r) => r.id));
    const [midnight, lastSecond, dayBefore, payment] = inserted.map((r) => r.id);

    const day = await reportsRepo.getActivityDay({
      day: "2026-09-20",
      timeZone: "Asia/Kolkata",
      excludePrefixes: ["payment."],
      limit: 100_000,
      offset: 0,
    });
    const ids = day.events.map((e) => e.id);
    expect(ids).toContain(midnight);
    expect(ids).toContain(lastSecond);
    expect(ids).not.toContain(dayBefore);
    expect(ids).not.toContain(payment);
    expect(day.events.find((e) => e.id === midnight)).toMatchObject({ actorName: nameOf.get(workerA.id), actorRole: "worker" });
  });

  it("the endpoints are owner-only", async () => {
    const ok = await request(app).get("/api/v1/reports/staff-activity?limit=5").set("Authorization", ownerAuth);
    expect(ok.status).toBe(200);
    const okBody = ok.body as { windows: unknown; staff: unknown[]; limit: number };
    expect(okBody.windows).toEqual({ designerDays: 45, floorDays: 30 });
    expect(okBody.staff.length).toBeLessThanOrEqual(5);
    expect((await request(app).get("/api/v1/reports/staff-activity?limit=500").set("Authorization", ownerAuth)).status).toBe(400);

    const days = await request(app).get("/api/v1/reports/activity-days").set("Authorization", ownerAuth);
    const dayList = days.body as { today: string; days: string[] };
    expect(dayList.days).toHaveLength(7);
    const today = await request(app).get(`/api/v1/reports/activity?day=${dayList.today}`).set("Authorization", ownerAuth);
    expect(today.status).toBe(200);
    const { events } = today.body as { events: { action: string }[] };
    expect(events.every((e) => !e.action.startsWith("payment."))).toBe(true);

    expect((await request(app).get("/api/v1/reports/activity?day=2020-01-01").set("Authorization", ownerAuth)).status).toBe(400);
    expect((await request(app).get("/api/v1/reports/activity?day=2026-02-31").set("Authorization", ownerAuth)).status).toBe(400);
    expect((await request(app).get("/api/v1/reports/staff-activity").set("Authorization", designerAuth)).status).toBe(403);
    expect((await request(app).get("/api/v1/reports/staff-activity")).status).toBe(401);
  });
});
