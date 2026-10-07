import { afterAll, afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authProvider } from "../../src/common/auth/supabase-auth-provider";
import { createFixtureUser, deleteFixtureUser, deleteFixtureOrder, closeDb } from "./helpers";
import { db } from "../../src/common/database/drizzle-client";
import { orderStatusHistory } from "../../src/modules/orders/infrastructure/order-status-history.schema";
import { DrizzleOrdersRepository } from "../../src/modules/orders/infrastructure/drizzle-orders.repository";
import { auditLog } from "../../src/common/audit/audit-log.schema";
import { orders } from "../../src/modules/orders/infrastructure/order.schema";
import { and, eq } from "drizzle-orm";
import { businessToday } from "../../src/common/time/business-date";
import { env } from "../../src/config/env";

/**
 * Integration coverage for the user-management and financial-reporting
 * endpoints added in the manual-testing-fixes pass: server-side user
 * pagination/search, single-user fetch, reactivate, the revenue report, and
 * the new dashboard stat/bucket surface -- real app, real auth, real Postgres.
 */
describe("Users & reports (integration)", () => {
  const app = createApp();
  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];

  async function ownerToken(): Promise<string> {
    const owner = await createFixtureUser("owner_manager", "Reports Owner");
    createdUserIds.push(owner.id);
    const session = await authProvider.signInWithPassword(owner.email, owner.password);
    return session.accessToken;
  }

  afterEach(async () => {
    for (const id of createdOrderIds.splice(0)) await deleteFixtureOrder(id);
    for (const id of createdUserIds.splice(0)) await deleteFixtureUser(id);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("paginates GET /users with a total and a bounded page", async () => {
    const token = await ownerToken();
    const res = await request(app).get("/api/v1/users?limit=2&offset=0").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body as { users: unknown[]; total: number; limit: number; offset: number };
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);
    expect(body.users.length).toBeLessThanOrEqual(2);
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  it("filters GET /users by a name search", async () => {
    const token = await ownerToken();
    const marker = `Zzsearch${Date.now()}`;
    const target = await createFixtureUser("designer", `${marker} Designer`);
    createdUserIds.push(target.id);

    const res = await request(app)
      .get(`/api/v1/users?search=${encodeURIComponent(marker)}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body as { users: { id: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.users[0]!.id).toBe(target.id);
  });

  it("fetches a single user via GET /users/:id", async () => {
    const token = await ownerToken();
    const target = await createFixtureUser("designer", "Single Fetch Designer");
    createdUserIds.push(target.id);

    const res = await request(app).get(`/api/v1/users/${target.id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect((res.body as { user: { id: string } }).user.id).toBe(target.id);
  });

  it("deactivates then reactivates a user", async () => {
    const token = await ownerToken();
    const target = await createFixtureUser("designer", "Toggle Designer");
    createdUserIds.push(target.id);

    const deactivate = await request(app)
      .post(`/api/v1/users/${target.id}/deactivate`)
      .set("Authorization", `Bearer ${token}`);
    expect(deactivate.status).toBe(204);

    const afterDeactivate = await request(app).get(`/api/v1/users/${target.id}`).set("Authorization", `Bearer ${token}`);
    expect((afterDeactivate.body as { user: { active: boolean } }).user.active).toBe(false);

    const reactivate = await request(app)
      .post(`/api/v1/users/${target.id}/reactivate`)
      .set("Authorization", `Bearer ${token}`);
    expect(reactivate.status).toBe(204);

    const afterReactivate = await request(app).get(`/api/v1/users/${target.id}`).set("Authorization", `Bearer ${token}`);
    expect((afterReactivate.body as { user: { active: boolean } }).user.active).toBe(true);
  });

  it("forbids a designer from listing users", async () => {
    const designer = await createFixtureUser("designer", "Nosy Designer");
    createdUserIds.push(designer.id);
    const session = await authProvider.signInWithPassword(designer.email, designer.password);

    const res = await request(app).get("/api/v1/users").set("Authorization", `Bearer ${session.accessToken}`);
    expect(res.status).toBe(403);
  });

  it("exposes the new dashboard stat fields to all roles, stripping payments for master_tailor", async () => {
    const masterTailor = await createFixtureUser("master_tailor", "Stats Master");
    createdUserIds.push(masterTailor.id);
    const session = await authProvider.signInWithPassword(masterTailor.email, masterTailor.password);

    const res = await request(app).get("/api/v1/orders/stats").set("Authorization", `Bearer ${session.accessToken}`);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    for (const field of ["total", "active", "completed", "deliveredThisMonth", "ready", "thisMonth", "inProduction", "overdue", "urgent"]) {
      expect(body[field]).toBeTypeOf("number");
    }
    // Payment aggregates are stripped for master_tailor (no payments:read).
    expect(body.pendingPayments).toBeUndefined();
    expect(body.collectedRevenue).toBeUndefined();
  });

  it("counts Ready and Delivered-this-month (not all-time) on the dashboard, with matching buckets", async () => {
    const designer = await createFixtureUser("designer", "Stage Cards Designer");
    const master = await createFixtureUser("master_tailor", "Stage Cards Master");
    createdUserIds.push(designer.id, master.id);
    const session = await authProvider.signInWithPassword(designer.email, designer.password);
    const repo = new DrizzleOrdersRepository();
    const make = async () => {
      const o = await repo.create({
        customerName: "Cards", phone: "9000000000", billNumber: `CARD-${Date.now()}-${Math.random()}`,
        bookingDate: "2026-10-01", dueDate: "2039-01-01", nextPaymentDate: null, designerId: designer.id, masterTailorId: master.id,
        productCategory: "saree", orderDetails: "cards", handWork: false, machineWork: false, purchaseRequired: false,
        paymentStatus: "unpaid", totalAmount: "100.00", productionStatus: "design_pending",
        designerInstructions: null, specialNotes: null, createdBy: designer.id, updatedBy: designer.id,
      });
      createdOrderIds.push(o.id);
      return o.id;
    };
    const ready = await make();
    await repo.updateStatus(ready, "ready", designer.id);
    const deliveredNow = await make();
    await repo.updateStatus(deliveredNow, "ready", designer.id);
    await repo.updateStatus(deliveredNow, "delivered", designer.id);
    // Delivered, but long ago: not this month's.
    const deliveredOld = await make();
    await repo.updateStatus(deliveredOld, "ready", designer.id);
    await repo.updateStatus(deliveredOld, "delivered", designer.id);
    await db
      .update(orderStatusHistory)
      .set({ createdAt: new Date("2025-01-15T10:00:00Z") })
      .where(and(eq(orderStatusHistory.orderId, deliveredOld), eq(orderStatusHistory.status, "delivered")));

    const auth = { Authorization: `Bearer ${session.accessToken}` };
    const stats = (await request(app).get("/api/v1/orders/stats").set(auth)).body as Record<string, number>;
    expect(stats).toMatchObject({ ready: 1, deliveredThisMonth: 1, completed: 2, inProduction: 0, active: 1 });

    const ids = async (bucket: string) =>
      ((await request(app).get(`/api/v1/orders?bucket=${bucket}`).set(auth)).body as { orders: { id: string }[] }).orders.map((o) => o.id);
    expect(await ids("ready")).toEqual([ready]);
    expect(await ids("delivered_this_month")).toEqual([deliveredNow]);
  });

  it("refuses Delivered from anything but Ready -- in the API and in the database itself", async () => {
    const token = await ownerToken();
    const designer = await createFixtureUser("designer", "Guard Designer");
    const master = await createFixtureUser("master_tailor", "Guard Master");
    createdUserIds.push(designer.id, master.id);
    const repo = new DrizzleOrdersRepository();
    const o = await repo.create({
      customerName: "Guard", phone: "9000000000", billNumber: `GUARD-${Date.now()}`,
      bookingDate: "2026-10-01", dueDate: "2039-01-01", nextPaymentDate: null, designerId: designer.id, masterTailorId: master.id,
      productCategory: "saree", orderDetails: "guard", handWork: false, machineWork: false, purchaseRequired: false,
      paymentStatus: "unpaid", totalAmount: "100.00", productionStatus: "design_pending",
      designerInstructions: null, specialNotes: null, createdBy: designer.id, updatedBy: designer.id,
    });
    createdOrderIds.push(o.id);
    await repo.updateStatus(o.id, "quality_check", designer.id);

    const res = await request(app)
      .patch(`/api/v1/orders/${o.id}/status`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "delivered" });
    expect(res.status).toBe(409);
    expect((res.body as { code: string }).code).toBe("ORDER_DELIVER_REQUIRES_READY");

    // A direct write that skips the API is refused by the trigger.
    await expect(db.update(orders).set({ productionStatus: "delivered" }).where(eq(orders.id, o.id))).rejects.toThrow();

    // The alteration loop, then delivery from Ready.
    for (const status of ["ready", "alteration", "ready", "delivered"]) {
      const step = await request(app)
        .patch(`/api/v1/orders/${o.id}/status`)
        .set("Authorization", `Bearer ${token}`)
        .send({ status });
      expect(step.status, status).toBe(200);
    }
    const history = await repo.listStatusHistory(o.id);
    expect(history.map((h) => h.status).slice(0, 4)).toEqual(["delivered", "ready", "alteration", "ready"]);
  });

  it("accepts a bucket filter on GET /orders", async () => {
    const token = await ownerToken();
    const res = await request(app).get("/api/v1/orders?bucket=overdue").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as { orders: unknown[] }).orders)).toBe(true);
  });

  it("GET /orders?createdFrom= (Kanban window): a real date pages normally; a bad one is a 400", async () => {
    const token = await ownerToken();
    const auth = `Bearer ${token}`;
    const ok = await request(app).get("/api/v1/orders?createdFrom=2026-01-01&limit=50").set("Authorization", auth);
    expect(ok.status).toBe(200);
    const body = ok.body as { orders: unknown[]; total: number; limit: number };
    expect(body.limit).toBe(50);
    expect(body.orders.length).toBeLessThanOrEqual(50);
    for (const bad of ["2026-02-31", "yesterday", "2026-1-1"]) {
      const res = await request(app).get(`/api/v1/orders?createdFrom=${bad}`).set("Authorization", auth);
      expect(res.status, bad).toBe(400);
      const due = await request(app).get(`/api/v1/orders?dueOn=${bad}`).set("Authorization", auth);
      expect(due.status, `dueOn=${bad}`).toBe(400);
    }
    expect((await request(app).get("/api/v1/orders?dueOn=2026-10-08").set("Authorization", auth)).status).toBe(200);
  });

  it("returns a revenue report over a year range to owner_manager but forbids a designer", async () => {
    const token = await ownerToken();
    const ownerRes = await request(app)
      .get("/api/v1/orders/revenue?from=2026-01-01&to=2026-12-31")
      .set("Authorization", `Bearer ${token}`);
    expect(ownerRes.status).toBe(200);
    const report = ownerRes.body as { cycleStartDay: number; from: string; to: string; periods: unknown[] };
    expect(typeof report.cycleStartDay).toBe("number");
    expect(report.from).toBe("2026-01-01");
    expect(report.to).toBe("2026-12-31");
    expect(Array.isArray(report.periods)).toBe(true);

    const designer = await createFixtureUser("designer", "Broke Designer");
    createdUserIds.push(designer.id);
    const session = await authProvider.signInWithPassword(designer.email, designer.password);
    const designerRes = await request(app)
      .get("/api/v1/orders/revenue")
      .set("Authorization", `Bearer ${session.accessToken}`);
    expect(designerRes.status).toBe(403);
  });

  it("returns a per-staff report to owner_manager (correct shape + month's weeks)", async () => {
    const token = await ownerToken();
    const designer = await createFixtureUser("designer", "Report Designer");
    createdUserIds.push(designer.id);

    const res = await request(app)
      .get(`/api/v1/orders/staff-report?staffId=${designer.id}&month=2026-07`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      staff: { id: string; role: string };
      summary: Record<string, number | string> & { paymentPendingAmount: string };
      weekly: { weekStart: string; booked: number; completed: number }[];
      month: string;
    };
    expect(body.staff.id).toBe(designer.id);
    expect(body.staff.role).toBe("designer");
    for (const field of ["booked", "active", "inProduction", "completed", "overdue", "urgent", "paymentPendingCount"]) {
      expect(body.summary[field]).toBeTypeOf("number");
    }
    // paymentPendingAmount is money -- a 2dp string on the wire, not a number.
    expect(body.summary.paymentPendingAmount).toBeTypeOf("string");
    expect(body.summary.paymentPendingAmount).toMatch(/^\d+\.\d{2}$/);
    // The month's weeks: continuous, zero-filled, oldest first (a month spans 4-6 Mondays).
    expect(body.month).toBe("2026-07");
    expect(body.weekly.length).toBeGreaterThanOrEqual(4);
    expect(body.weekly.length).toBeLessThanOrEqual(6);
    expect(body.weekly[0]!.weekStart < body.weekly[body.weekly.length - 1]!.weekStart).toBe(true);
  });

  it("counts the staff report's weekly booked / completed correctly (first delivery only, bookings in the window only)", async () => {
    const designer = await createFixtureUser("designer", "Weekly Designer");
    const master = await createFixtureUser("master_tailor", "Weekly Master");
    createdUserIds.push(designer.id, master.id);
    const repo = new DrizzleOrdersRepository();
    const make = async (bookingDate: string) => {
      const o = await repo.create({
        customerName: "Weekly", phone: "9000000000", billNumber: `WK-${Date.now()}-${Math.random()}`,
        bookingDate, dueDate: "2039-01-01", nextPaymentDate: null, designerId: designer.id, masterTailorId: master.id,
        productCategory: "saree", orderDetails: "weekly", handWork: false, machineWork: false, purchaseRequired: false,
        paymentStatus: "unpaid", totalAmount: "100.00", productionStatus: "design_pending",
        designerInstructions: null, specialNotes: null, createdBy: designer.id, updatedBy: designer.id,
      });
      createdOrderIds.push(o.id);
      return o.id;
    };
    const deliverAt = async (orderId: string, at: string) => {
      await db.insert(orderStatusHistory).values({ orderId, status: "delivered", label: "Delivered", changedBy: designer.id, createdAt: new Date(at) });
    };
    // July 2026's weeks start on Mondays Jun 29, Jul 6, 13, 20, 27.
    const a = await make("2026-07-01"); // booked wk Jun 29, delivered wk Jul 13
    await deliverAt(a, "2026-07-15T10:00:00Z");
    const b = await make("2026-07-08"); // booked wk Jul 6; FIRST delivery was in June -> not a July completion
    await deliverAt(b, "2026-06-20T10:00:00Z");
    await deliverAt(b, "2026-07-16T10:00:00Z");
    const c = await make("2026-06-10"); // booked before the window (not counted), delivered wk Jul 20
    await deliverAt(c, "2026-07-21T10:00:00Z");
    await make("2026-07-28"); // booked wk Jul 27, not delivered

    const report = await repo.getStaffReport(designer.id, { from: "2026-07-01", to: "2026-07-31" });
    expect(report?.weekly).toEqual([
      { weekStart: "2026-06-29", booked: 1, completed: 0 },
      { weekStart: "2026-07-06", booked: 1, completed: 0 },
      { weekStart: "2026-07-13", booked: 0, completed: 1 },
      { weekStart: "2026-07-20", booked: 0, completed: 1 },
      { weekStart: "2026-07-27", booked: 1, completed: 0 },
    ]);
  });

  it("returns the payment-ledger activity feed (created/updated/deleted) to owner_manager but forbids a designer", async () => {
    const owner = await createFixtureUser("owner_manager", "Ledger Owner");
    const master = await createFixtureUser("master_tailor", "Ledger Master");
    createdUserIds.push(owner.id, master.id);
    const session = await authProvider.signInWithPassword(owner.email, owner.password);
    const auth = `Bearer ${session.accessToken}`;
    // The SHOP day (the feed cuts days at midnight in BUSINESS_TIMEZONE), not
    // the UTC day -- they differ between 00:00 and 05:30 IST.
    const today = businessToday(new Date(), env.BUSINESS_TIMEZONE);

    // Create an order, then record -> edit -> remove a payment so all three
    // audit verbs land in the feed.
    const createRes = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", auth)
      .send({
        customerName: "Ledger Feed Customer",
        phone: "9000000030",
        billNumber: `LEDGER-${Date.now()}`,
        bookingDate: today,
        // A free day far ahead: "today" can already be at delivery capacity.
        dueDate: new Date(Date.UTC(2040, 0, 1) + Math.floor(Math.random() * 3650) * 86_400_000).toISOString().slice(0, 10),
        designerId: owner.id,
        masterTailorId: master.id,
        productCategory: "saree",
        orderDetails: "Ledger feed fixture",
        totalAmount: 2000,
        productionStatus: "design_pending",
      });
    expect(createRes.status).toBe(201);
    const orderId = (createRes.body as { order: { id: string; orderNumber: string } }).order.id;
    const orderNumber = (createRes.body as { order: { orderNumber: string } }).order.orderNumber;
    createdOrderIds.push(orderId);

    const payRes = await request(app)
      .post(`/api/v1/orders/${orderId}/payments`)
      .set("Authorization", auth)
      .send({ amount: 500, method: "cash" });
    expect(payRes.status).toBe(201);
    const paymentId = (payRes.body as { payment: { id: string } }).payment.id;

    const editRes = await request(app)
      .patch(`/api/v1/orders/${orderId}/payments/${paymentId}`)
      .set("Authorization", auth)
      .send({ amount: 800 });
    expect(editRes.status).toBe(200);

    const delRes = await request(app).delete(`/api/v1/orders/${orderId}/payments/${paymentId}`).set("Authorization", auth);
    expect(delRes.status).toBe(204);

    const feed = await request(app)
      .get(`/api/v1/orders/ledger-events?from=${today}&to=${today}&limit=50`)
      .set("Authorization", auth);
    expect(feed.status).toBe(200);
    const body = feed.body as {
      events: { action: string; at: string; actorName: string | null; orderNumber: string | null; snapshot?: { amount: string }; before?: { amount: string }; after?: { amount: string } }[];
      total: number;
      limit: number;
      from: string;
      to: string;
    };
    expect(body.limit).toBe(50);
    expect(body.from).toBe(today);
    expect(body.to).toBe(today);
    expect(body.total).toBeGreaterThanOrEqual(3);

    const mine = body.events.filter((e) => e.orderNumber === orderNumber);
    const created = mine.find((e) => e.action === "created");
    const updated = mine.find((e) => e.action === "updated");
    const deleted = mine.find((e) => e.action === "deleted");
    expect(created?.snapshot?.amount).toBe("500.00");
    expect(updated?.before?.amount).toBe("500.00");
    expect(updated?.after?.amount).toBe("800.00");
    expect(deleted?.snapshot?.amount).toBe("800.00");
    // The actor's name is resolved from profiles.
    expect(created?.actorName).toBe("Ledger Owner");

    // A designer has no reports:financial -> forbidden.
    const designer = await createFixtureUser("designer", "Ledger Nosy Designer");
    createdUserIds.push(designer.id);
    const dSession = await authProvider.signInWithPassword(designer.email, designer.password);
    const forbidden = await request(app).get("/api/v1/orders/ledger-events").set("Authorization", `Bearer ${dSession.accessToken}`);
    expect(forbidden.status).toBe(403);
  });

  it("exports one week/month of ledger activity unpaged, by SHOP day, and refuses longer windows", async () => {
    const owner = await createFixtureUser("owner_manager", "Export Owner");
    createdUserIds.push(owner.id);
    const session = await authProvider.signInWithPassword(owner.email, owner.password);
    const auth = `Bearer ${session.accessToken}`;
    // Far-future instants so no real activity shares the window. 18:15Z = 23:45 IST on 30 Jun;
    // 18:45Z = 00:15 IST on 1 Jul -- a UTC-midnight cut would file BOTH under June.
    const marker = `export-${Date.now()}`;
    const inserted = await db
      .insert(auditLog)
      .values([
        { actorId: owner.id, action: "payment.created", entityType: "payment", entityId: marker, metadata: { amount: "500.00", method: "cash" }, createdAt: new Date("2031-06-30T18:15:00Z") },
        { actorId: owner.id, action: "payment.deleted", entityType: "payment", entityId: marker, metadata: { amount: "200.00", method: "upi" }, createdAt: new Date("2031-06-30T18:45:00Z") },
      ])
      .returning({ id: auditLog.id });
    try {
      const june = await request(app).get("/api/v1/orders/ledger-events/export?from=2031-06-01&to=2031-06-30").set("Authorization", auth);
      expect(june.status).toBe(200);
      const juneBody = june.body as { events: { id: string; action: string; actorName: string; snapshot?: { amount: string } }[]; total: number; timeZone: string };
      expect(juneBody.timeZone).toBeTruthy();
      expect(juneBody.events.map((e) => e.action)).toEqual(["created"]);
      expect(juneBody.events[0]!.snapshot?.amount).toBe("500.00");
      expect(juneBody.events[0]!.actorName).toBe("Export Owner");

      const july = await request(app).get("/api/v1/orders/ledger-events/export?from=2031-07-01&to=2031-07-31").set("Authorization", auth);
      expect((july.body as { events: { action: string }[] }).events.map((e) => e.action)).toEqual(["deleted"]);

      // The paged Ledger Activity table uses the same shop-day window.
      const table = await request(app).get("/api/v1/orders/ledger-events?from=2031-06-01&to=2031-06-30").set("Authorization", auth);
      expect((table.body as { total: number }).total).toBe(1);

      // No yearly (or > 31-day) export, no backwards or fake dates.
      for (const q of ["from=2031-01-01&to=2031-12-31", "from=2031-07-01&to=2031-08-01", "from=2031-07-10&to=2031-07-01", "from=2031-02-30&to=2031-03-01", "to=2031-07-31"]) {
        const bad = await request(app).get(`/api/v1/orders/ledger-events/export?${q}`).set("Authorization", auth);
        expect(bad.status, q).toBe(400);
        expect((bad.body as { code: string }).code, q).toBe("LEDGER_EXPORT_RANGE_INVALID");
      }

      // Same audience as the ledger: a designer is refused.
      const designer = await createFixtureUser("designer", "Export Nosy Designer");
      createdUserIds.push(designer.id);
      const dSession = await authProvider.signInWithPassword(designer.email, designer.password);
      const forbidden = await request(app)
        .get("/api/v1/orders/ledger-events/export?from=2031-06-01&to=2031-06-30")
        .set("Authorization", `Bearer ${dSession.accessToken}`);
      expect(forbidden.status).toBe(403);
    } finally {
      for (const row of inserted) await db.delete(auditLog).where(eq(auditLog.id, row.id));
    }
  });

  it("a ₹0 order (free work) is fully_paid and stays out of Pending Payments; editing the total re-derives it", async () => {
    const owner = await createFixtureUser("owner_manager", "Free Work Owner");
    const master = await createFixtureUser("master_tailor", "Free Work Master");
    createdUserIds.push(owner.id, master.id);
    const session = await authProvider.signInWithPassword(owner.email, owner.password);
    const auth = `Bearer ${session.accessToken}`;
    const bill = `FREE-${Date.now()}`;

    const createRes = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", auth)
      .send({
        customerName: "Free Work Customer",
        phone: "9000000031",
        billNumber: bill,
        dueDate: "2039-01-02",
        designerId: owner.id,
        masterTailorId: master.id,
        productCategory: "saree",
        orderDetails: "Promotion piece",
        totalAmount: 0,
        nextPaymentDate: "2026-01-01", // a past date must not drag it into Overdue
        productionStatus: "design_pending",
      });
    expect(createRes.status).toBe(201);
    const created = (createRes.body as { order: { id: string; paymentStatus: string } }).order;
    createdOrderIds.push(created.id);
    expect(created.paymentStatus).toBe("fully_paid");

    const inBucket = async (bucket: string) => {
      const res = await request(app).get(`/api/v1/orders?bucket=${bucket}&search=${bill}`).set("Authorization", auth);
      expect(res.status).toBe(200);
      return (res.body as { orders: { id: string }[] }).orders.some((o) => o.id === created.id);
    };
    for (const bucket of ["pending_payment", "payment_overdue", "payment_upcoming"]) {
      expect(await inBucket(bucket), bucket).toBe(false);
    }

    // The price changes later: the owner raises it (with a reason) -> nothing collected yet -> unpaid, and it shows up.
    const priced = await request(app)
      .put(`/api/v1/orders/${created.id}/price`)
      .set("Authorization", auth)
      .send({ totalAmount: 4500, reason: "No longer a free piece" });
    expect(priced.status).toBe(200);
    expect((priced.body as { order: { paymentStatus: string } }).order.paymentStatus).toBe("unpaid");
    expect(await inBucket("pending_payment")).toBe(true);
    expect(await inBucket("payment_overdue")).toBe(true);

    // Discounted back to ₹0 (e.g. it became a contest piece) -> fully_paid again.
    const free = await request(app)
      .put(`/api/v1/orders/${created.id}/price`)
      .set("Authorization", auth)
      .send({ totalAmount: 0, reason: "Design contest piece" });
    expect(free.status).toBe(200);
    expect((free.body as { order: { paymentStatus: string } }).order.paymentStatus).toBe("fully_paid");
    expect(await inBucket("pending_payment")).toBe(false);
  });

  it("requires staffId, 404s a non-staff id, and forbids non-owner roles on the staff report", async () => {
    const token = await ownerToken();
    // Missing staffId -> 400.
    const noId = await request(app).get("/api/v1/orders/staff-report").set("Authorization", `Bearer ${token}`);
    expect(noId.status).toBe(400);
    // A random (non-existent) id -> 404.
    const bogus = await request(app)
      .get("/api/v1/orders/staff-report?staffId=00000000-0000-0000-0000-000000000000")
      .set("Authorization", `Bearer ${token}`);
    expect(bogus.status).toBe(404);
    // Accountant has reports:financial but NOT reports:staff -> 403.
    const accountant = await createFixtureUser("accountant", "No Staff Report Accountant");
    createdUserIds.push(accountant.id);
    const session = await authProvider.signInWithPassword(accountant.email, accountant.password);
    const forbidden = await request(app)
      .get(`/api/v1/orders/staff-report?staffId=${accountant.id}`)
      .set("Authorization", `Bearer ${session.accessToken}`);
    expect(forbidden.status).toBe(403);
  });
});
