import { afterAll, afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authProvider } from "../../src/common/auth/supabase-auth-provider";
import { createFixtureUser, deleteFixtureUser, deleteFixtureOrder, closeDb } from "./helpers";

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
    for (const field of ["total", "active", "completed", "thisMonth", "inProduction", "overdue", "urgent"]) {
      expect(body[field]).toBeTypeOf("number");
    }
    // Payment aggregates are stripped for master_tailor (no payments:read).
    expect(body.pendingPayments).toBeUndefined();
    expect(body.collectedRevenue).toBeUndefined();
  });

  it("accepts a bucket filter on GET /orders", async () => {
    const token = await ownerToken();
    const res = await request(app).get("/api/v1/orders?bucket=overdue").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as { orders: unknown[] }).orders)).toBe(true);
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

  it("returns the payment-ledger activity feed (created/updated/deleted) to owner_manager but forbids a designer", async () => {
    const owner = await createFixtureUser("owner_manager", "Ledger Owner");
    const master = await createFixtureUser("master_tailor", "Ledger Master");
    createdUserIds.push(owner.id, master.id);
    const session = await authProvider.signInWithPassword(owner.email, owner.password);
    const auth = `Bearer ${session.accessToken}`;
    const today = new Date().toISOString().slice(0, 10);

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
        dueDate: today,
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
