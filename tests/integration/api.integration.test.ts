import { afterAll, afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createApp } from "../../src/app";
import { authProvider } from "../../src/common/auth/supabase-auth-provider";
import { db } from "../../src/common/database/drizzle-client";
import { orderAuditLog } from "../../src/modules/orders/infrastructure/order-audit-log.schema";
import { createFixtureUser, deleteFixtureUser, deleteFixtureOrder, closeDb } from "./helpers";
import { businessToday } from "../../src/common/time/business-date";
import { env } from "../../src/config/env";

/**
 * API-endpoint integration coverage: the real Express app (`createApp()`),
 * real auth middleware, real capability guards, real Postgres -- nothing
 * stubbed. Complements tests/rbac-matrix.mjs (a broader ad hoc per-role
 * smoke script that needs a separately-running `npm run dev`); this suite
 * runs the app in-process via supertest so it's part of `npm run
 * test:integration` with no separately-running server required.
 */
describe("API endpoints (integration)", () => {
  const app = createApp();
  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];

  afterEach(async () => {
    for (const id of createdOrderIds.splice(0)) await deleteFixtureOrder(id);
    for (const id of createdUserIds.splice(0)) await deleteFixtureUser(id);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("order list filters (stage, timeline, booking year / month) and the phone lookup for the new-order form", async () => {
    const owner = await createFixtureUser("owner_manager", "Filters Owner");
    const designer = await createFixtureUser("designer", "Filters Designer");
    const master = await createFixtureUser("master_tailor", "Filters Master");
    const pm = await createFixtureUser("production_manager", "Filters PM");
    createdUserIds.push(owner.id, designer.id, master.id, pm.id);
    const auth = async (u: { email: string; password: string }) => `Bearer ${(await authProvider.signInWithPassword(u.email, u.password)).accessToken}`;
    const [ownerAuth, masterAuth, pmAuth] = await Promise.all([auth(owner), auth(master), auth(pm)]);
    const phone = `7${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
    const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

    const create = async (customerName: string, bookingDate: string, dueDate: string, extra: Record<string, unknown> = {}) => {
      const res = await request(app)
        .post("/api/v1/orders")
        .set("Authorization", ownerAuth)
        .send({
          customerName,
          phone,
          billNumber: `FLT-${Date.now()}-${Math.random()}`,
          bookingDate,
          dueDate,
          designerId: designer.id,
          masterTailorId: master.id,
          productCategory: "saree",
          orderDetails: "filters fixture",
          productionStatus: "design_pending",
          ...extra,
        });
      expect(res.status).toBe(201);
      const id = (res.body as { order: { id: string } }).order.id;
      createdOrderIds.push(id);
      return id;
    };
    const overdue = await create("Filter Overdue", "2025-03-04", iso(-5));
    const soon = await create("Filter Soon", "2025-03-20", iso(5));
    const later = await create("Filter Later", "2025-07-01", iso(40));

    const ids = async (query: string) => {
      const res = await request(app).get(`/api/v1/orders?limit=100&${query}`).set("Authorization", ownerAuth);
      expect(res.status, query).toBe(200);
      return (res.body as { orders: { id: string }[] }).orders.map((o) => o.id).filter((id) => [overdue, soon, later].includes(id));
    };
    expect(await ids("bookedYear=2025&bookedMonth=3")).toEqual(expect.arrayContaining([overdue, soon]));
    expect(await ids("bookedYear=2025&bookedMonth=3")).not.toContain(later);
    expect((await ids("bookedYear=2025")).sort()).toEqual([overdue, soon, later].sort());
    expect(await ids("timeline=overdue&bookedYear=2025")).toEqual([overdue]);
    expect(await ids("timeline=due_soon&bookedYear=2025")).toEqual([soon]);
    expect(await ids("timeline=on_track&bookedYear=2025")).toEqual([later]);
    expect(await ids("status=design_pending&bookedYear=2025&bookedMonth=7")).toEqual([later]);
    // The pipeline steps' lists, with a search on top (the dashboard's focused pages).
    expect((await ids("bucket=pipeline_design&bookedYear=2025")).sort()).toEqual([overdue, soon, later].sort());
    expect(await ids("bucket=pipeline_checks&bookedYear=2025")).toEqual([]);
    expect(await ids("bucket=pipeline_design&bookedYear=2025&search=Filter%20Soon")).toEqual([soon]);
    for (const bad of ["timeline=soonish", "bookedYear=99", "bookedMonth=3", "bookedYear=2025&bookedMonth=13"]) {
      expect((await request(app).get(`/api/v1/orders?${bad}`).set("Authorization", ownerAuth)).status, bad).toBe(400);
    }

    // Today, by the shop's clock: an order due today (to deliver), and one whose next payment is due today (to collect).
    const today = businessToday(new Date(), env.BUSINESS_TIMEZONE);
    // Today may already be a full delivery day locally: the booking confirms it with the PM, as the form does.
    const deliverToday = await create("Filter Deliver Today", "2025-09-01", today, { confirmedWithProductionManager: true });
    const collectToday = await create("Filter Collect Today", "2025-09-02", iso(30));
    expect((await request(app).put(`/api/v1/orders/${collectToday}/price`).set("Authorization", ownerAuth).send({ totalAmount: 5000 })).status).toBe(200);
    const paid = await request(app)
      .post(`/api/v1/orders/${collectToday}/payments`)
      .set("Authorization", ownerAuth)
      .send({ amount: 1000, method: "cash", nextPaymentDate: today });
    expect(paid.status).toBe(201);
    const inBucket = async (bucket: string) =>
      ((await request(app).get(`/api/v1/orders?limit=100&bucket=${bucket}&search=Filter`).set("Authorization", ownerAuth)).body as { orders: { id: string }[] }).orders.map((o) => o.id);
    const bookedToday = await create("Filter Booked Today", today, iso(60));
    expect(await inBucket("booked_today")).toEqual([bookedToday]);
    expect(await inBucket("due_today")).toEqual([deliverToday]);
    expect(await inBucket("payment_due_today")).toEqual([collectToday]);
    expect(await inBucket("payment_upcoming")).not.toContain(collectToday);
    expect(await inBucket("payment_overdue")).not.toContain(collectToday);
    const stats = (await request(app).get("/api/v1/orders/stats").set("Authorization", ownerAuth)).body as Record<string, number>;
    expect(stats.bookedToday).toBeGreaterThanOrEqual(1);
    expect(stats.dueToday).toBeGreaterThanOrEqual(1);
    expect(stats.paymentDueToday).toBeGreaterThanOrEqual(1);
    expect(typeof stats.paymentOverdue).toBe("number");
    // A master tailor sees what's due today, never the money.
    const asMaster = (await request(app).get("/api/v1/orders/stats").set("Authorization", masterAuth)).body as Record<string, unknown>;
    expect(typeof asMaster.dueToday).toBe("number");
    expect(asMaster.paymentDueToday).toBeUndefined();
    expect(asMaster.paymentOverdue).toBeUndefined();

    // "Fetch customer details": newest first, only on request, only roles that create orders.
    const lookup = await request(app).get(`/api/v1/orders/customer-lookup?phone=${phone}`).set("Authorization", pmAuth);
    expect(lookup.status).toBe(200);
    expect((lookup.body as { matches: { customerName: string }[] }).matches.map((m) => m.customerName)).toEqual([
      "Filter Booked Today",
      "Filter Collect Today",
      "Filter Deliver Today",
      "Filter Later",
      "Filter Soon",
    ]);
    expect((await request(app).get(`/api/v1/orders/customer-lookup?phone=${phone}`).set("Authorization", masterAuth)).status).toBe(403);
    expect((await request(app).get("/api/v1/orders/customer-lookup?phone=12345").set("Authorization", ownerAuth)).status).toBe(400);
  });

  it("GET /health responds without authentication", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe("ok");
  });

  it("applies secure HTTP headers (helmet) to every response", async () => {
    const res = await request(app).get("/health");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("rejects a protected route with no bearer token", async () => {
    const res = await request(app).get("/api/v1/orders");
    expect(res.status).toBe(401);
  });

  it("rejects a protected route with a garbage bearer token", async () => {
    const res = await request(app).get("/api/v1/orders").set("Authorization", "Bearer not-a-real-token");
    expect(res.status).toBe(401);
  });

  it("allows a real logged-in designer to create and then read back their own order", async () => {
    const designer = await createFixtureUser("designer", "API Integration Designer");
    const masterTailor = await createFixtureUser("master_tailor", "API Integration Master");
    createdUserIds.push(designer.id, masterTailor.id);

    const session = await authProvider.signInWithPassword(designer.email, designer.password);

    const createRes = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", `Bearer ${session.accessToken}`)
      .send({
        customerName: "API Integration Customer",
        phone: "9000000001",
        billNumber: `API-${Date.now()}`,
        bookingDate: "2026-01-01",
        dueDate: "2026-02-01",
        designerId: designer.id,
        masterTailorId: masterTailor.id,
        productCategory: "saree",
        orderDetails: "Created via API integration test",
        handWork: false,
        machineWork: true,
        purchaseRequired: false,
        paymentStatus: "advance_paid",
        totalAmount: 1000,
        productionStatus: "design_pending",
      });

    expect(createRes.status).toBe(201);
    const orderId = (createRes.body as { order: { id: string } }).order.id;
    createdOrderIds.push(orderId);

    const readRes = await request(app)
      .get(`/api/v1/orders/${orderId}`)
      .set("Authorization", `Bearer ${session.accessToken}`);
    expect(readRes.status).toBe(200);
    expect((readRes.body as { order: { customerName: string } }).order.customerName).toBe("API Integration Customer");

    // GET /orders returns a bounded, paginated envelope, not a bare array.
    const listRes = await request(app)
      .get("/api/v1/orders?limit=5&offset=0")
      .set("Authorization", `Bearer ${session.accessToken}`);
    expect(listRes.status).toBe(200);
    const list = listRes.body as { orders: { id: string }[]; total: number; limit: number; offset: number };
    expect(Array.isArray(list.orders)).toBe(true);
    expect(list.orders.length).toBeLessThanOrEqual(5);
    expect(list.limit).toBe(5);
    expect(list.offset).toBe(0);
    expect(list.total).toBeGreaterThanOrEqual(1);
    expect(list.orders.some((o) => o.id === orderId)).toBe(true);

    // Creating the order wrote its order_audit_log row in the same transaction,
    // attributed to the acting designer and correlated with a request id.
    const auditRows = await db
      .select()
      .from(orderAuditLog)
      .where(and(eq(orderAuditLog.orderId, orderId), eq(orderAuditLog.action, "created")));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorId).toBe(designer.id);
    expect(auditRows[0]?.requestId).toBeTruthy();
  });

  it("a discount can't go below what's been collected, and an edit can't change the price at all (ADR 0008)", async () => {
    const owner = await createFixtureUser("owner_manager", "API Integration Owner");
    const masterTailor = await createFixtureUser("master_tailor", "API Integration Master 2");
    createdUserIds.push(owner.id, masterTailor.id);
    const session = await authProvider.signInWithPassword(owner.email, owner.password);
    const auth = `Bearer ${session.accessToken}`;

    const createRes = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", auth)
      .send({
        customerName: "Overpaid Guard Customer",
        phone: "9000000010",
        billNumber: `API-${Date.now()}`,
        bookingDate: "2026-01-01",
        dueDate: "2026-02-01",
        designerId: owner.id,
        masterTailorId: masterTailor.id,
        productCategory: "saree",
        orderDetails: "Total-below-paid guard fixture",
        handWork: false,
        machineWork: true,
        purchaseRequired: false,
        totalAmount: 1000,
        productionStatus: "design_pending",
      });
    expect(createRes.status).toBe(201);
    const orderId = (createRes.body as { order: { id: string } }).order.id;
    createdOrderIds.push(orderId);

    // Collect ₹600 against the ₹1000 order.
    const payRes = await request(app)
      .post(`/api/v1/orders/${orderId}/payments`)
      .set("Authorization", auth)
      .send({ amount: 600, method: "cash" });
    expect(payRes.status).toBe(201);

    // An order edit can't change the total (it may resend the same one)...
    const viaEdit = await request(app).patch(`/api/v1/orders/${orderId}`).set("Authorization", auth).send({ totalAmount: 800 });
    expect(viaEdit.status).toBe(400);
    expect((viaEdit.body as { code: string }).code).toBe("ORDER_PRICE_USE_PRICING");
    const sameTotal = await request(app)
      .patch(`/api/v1/orders/${orderId}`)
      .set("Authorization", auth)
      .send({ totalAmount: "1000.00", orderDetails: "Edited, same price" });
    expect(sameTotal.status).toBe(200);

    // ...a discount to ₹500 (below the ₹600 collected) is rejected...
    const badRes = await request(app)
      .put(`/api/v1/orders/${orderId}/price`)
      .set("Authorization", auth)
      .send({ totalAmount: 500, reason: "Too big a discount" });
    expect(badRes.status).toBe(400);
    expect((badRes.body as { code: string }).code).toBe("ORDER_TOTAL_BELOW_PAID");

    // ...but a discount to ₹800 (still >= ₹600) is fine, and re-derives to advance_paid.
    const okRes = await request(app)
      .put(`/api/v1/orders/${orderId}/price`)
      .set("Authorization", auth)
      .send({ totalAmount: 800, reason: "Loyal customer" });
    expect(okRes.status).toBe(200);
    const ok = okRes.body as { order: { paymentStatus: string; totalAmount: string }; change: { kind: string; previousTotal: string } };
    expect(ok.order.paymentStatus).toBe("advance_paid");
    expect(ok.order.totalAmount).toBe("800.00");
    expect(ok.change).toMatchObject({ kind: "correction", previousTotal: "1000.00" });
  });

  it("advances an order into the Falls / Kutchu production stage (status + history both accept it)", async () => {
    const owner = await createFixtureUser("owner_manager", "FK Owner");
    const master = await createFixtureUser("master_tailor", "FK Master");
    createdUserIds.push(owner.id, master.id);
    const session = await authProvider.signInWithPassword(owner.email, owner.password);
    const auth = `Bearer ${session.accessToken}`;

    const createRes = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", auth)
      .send({
        customerName: "Falls Kutchu Customer",
        phone: "9000000040",
        billNumber: `API-${Date.now()}`,
        bookingDate: "2026-01-01",
        dueDate: "2026-02-01",
        designerId: owner.id,
        masterTailorId: master.id,
        productCategory: "saree",
        orderDetails: "Falls/Kutchu fixture",
        totalAmount: 1000,
        productionStatus: "design_approved",
      });
    expect(createRes.status).toBe(201);
    const orderId = (createRes.body as { order: { id: string } }).order.id;
    createdOrderIds.push(orderId);

    // The transaction writes BOTH orders.production_status AND an
    // order_status_history row -- each has its own CHECK constraint, so this
    // guards against only one of them knowing the new value (a real bug we hit).
    const patch = await request(app)
      .patch(`/api/v1/orders/${orderId}/status`)
      .set("Authorization", auth)
      .send({ status: "falls_kutchu" });
    expect(patch.status).toBe(200);
    expect((patch.body as { order: { productionStatus: string } }).order.productionStatus).toBe("falls_kutchu");

    const history = await request(app).get(`/api/v1/orders/${orderId}/history`).set("Authorization", auth);
    expect(history.status).toBe(200);
    const entries = (history.body as { history: { status: string; label: string }[] }).history;
    const fk = entries.find((h) => h.status === "falls_kutchu");
    expect(fk?.label).toBe("Falls / Kutchu");
  });

  it("clamps an over-large limit to the max page size", async () => {
    const designer = await createFixtureUser("designer", "API Integration Limit Designer");
    createdUserIds.push(designer.id);
    const session = await authProvider.signInWithPassword(designer.email, designer.password);

    const res = await request(app)
      .get("/api/v1/orders?limit=99999")
      .set("Authorization", `Bearer ${session.accessToken}`);
    expect(res.status).toBe(200);
    expect((res.body as { limit: number }).limit).toBe(100); // MAX_ORDERS_LIMIT
  });

  it("forbids a master_tailor from creating an order (orders:create is designer/owner_manager only)", async () => {
    const masterTailor = await createFixtureUser("master_tailor", "API Integration Master Forbidden");
    createdUserIds.push(masterTailor.id);

    const session = await authProvider.signInWithPassword(masterTailor.email, masterTailor.password);

    const res = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", `Bearer ${session.accessToken}`)
      .send({
        customerName: "Should Be Rejected",
        phone: "9000000002",
        billNumber: `API-${Date.now()}`,
        bookingDate: "2026-01-01",
        dueDate: "2026-02-01",
        designerId: masterTailor.id,
        masterTailorId: masterTailor.id,
        productCategory: "saree",
        orderDetails: "Should never be created",
        handWork: false,
        machineWork: true,
        purchaseRequired: false,
        paymentStatus: "advance_paid",
        totalAmount: 1000,
        productionStatus: "design_pending",
      });

    expect(res.status).toBe(403);
  });

  it("lets an authenticated outsider VIEW a single order read-only (payments stripped, writes forbidden)", async () => {
    const owner = await createFixtureUser("owner_manager", "VO Owner");
    const designer = await createFixtureUser("designer", "VO Assigned Designer");
    const outsider = await createFixtureUser("designer", "VO Outsider Designer");
    const master = await createFixtureUser("master_tailor", "VO Master");
    createdUserIds.push(owner.id, designer.id, outsider.id, master.id);
    const ownerSession = await authProvider.signInWithPassword(owner.email, owner.password);

    const createRes = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", `Bearer ${ownerSession.accessToken}`)
      .send({
        customerName: "View Only Customer",
        phone: "9000000020",
        billNumber: `API-${Date.now()}`,
        bookingDate: "2026-01-01",
        dueDate: "2026-02-01",
        designerId: designer.id,
        masterTailorId: master.id,
        productCategory: "saree",
        orderDetails: "View-only fixture",
        totalAmount: 5000,
        productionStatus: "design_pending",
      });
    expect(createRes.status).toBe(201);
    const orderId = (createRes.body as { order: { id: string } }).order.id;
    createdOrderIds.push(orderId);

    const outsiderSession = await authProvider.signInWithPassword(outsider.email, outsider.password);
    const auth = `Bearer ${outsiderSession.accessToken}`;

    // Reads the order (view-only) -- 200, but payment fields are absent.
    const view = await request(app).get(`/api/v1/orders/${orderId}`).set("Authorization", auth);
    expect(view.status).toBe(200);
    const order = (view.body as { order: Record<string, unknown> }).order;
    expect(order.customerName).toBe("View Only Customer");
    expect(order.paymentStatus).toBeUndefined();
    expect(order.totalAmount).toBeUndefined();
    expect(order.outstanding).toBeUndefined();

    // ...cannot see its payment ledger (payments stay assignment/role gated).
    const ledger = await request(app).get(`/api/v1/orders/${orderId}/payments`).set("Authorization", auth);
    expect(ledger.status).toBe(403);

    // ...but CAN advance its stage even though it isn't assigned to them -- the
    // shop-floor model: whoever receives the garment advances it. A designer is
    // in the design tier, so Design Pending -> Design Approved is theirs to make.
    const patch = await request(app)
      .patch(`/api/v1/orders/${orderId}/status`)
      .set("Authorization", auth)
      .send({ status: "design_approved" });
    expect(patch.status).toBe(200);
    expect((patch.body as { order: { productionStatus: string } }).order.productionStatus).toBe("design_approved");

    // ...but can't jump from there to Cutting: that passes over Production
    // Manager Received, a stage a designer can't set. (This test previously
    // asserted that jump SUCCEEDED -- it was the skip gap, now closed.)
    const skip = await request(app).patch(`/api/v1/orders/${orderId}/status`).set("Authorization", auth).send({ status: "cutting" });
    expect(skip.status).toBe(403);
    expect((skip.body as { code: string }).code).toBe("ORDER_STATUS_TRANSITION_FORBIDDEN");
    // Rolled back -- the order is still at Design Approved, no stray history row.
    const after = await request(app).get(`/api/v1/orders/${orderId}`).set("Authorization", auth);
    expect((after.body as { order: { productionStatus: string } }).order.productionStatus).toBe("design_approved");
  });

  it("enforces forward-only, idempotent, concurrency-safe status changes", async () => {
    const owner = await createFixtureUser("owner_manager", "FO Owner");
    const master = await createFixtureUser("master_tailor", "FO Master");
    createdUserIds.push(owner.id, master.id);
    const session = await authProvider.signInWithPassword(owner.email, owner.password);
    const auth = `Bearer ${session.accessToken}`;

    const createRes = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", auth)
      .send({
        customerName: "Forward Only Customer",
        phone: "9000000050",
        billNumber: `API-${Date.now()}`,
        bookingDate: "2026-01-01",
        dueDate: "2026-02-01",
        designerId: owner.id,
        masterTailorId: master.id,
        productCategory: "saree",
        orderDetails: "Forward-only fixture",
        totalAmount: 1000,
        productionStatus: "design_pending",
      });
    const orderId = (createRes.body as { order: { id: string } }).order.id;
    createdOrderIds.push(orderId);

    // Move forward to cutting.
    const fwd = await request(app).patch(`/api/v1/orders/${orderId}/status`).set("Authorization", auth).send({ status: "cutting" });
    expect(fwd.status).toBe(200);

    // Re-applying the SAME stage is rejected (idempotency) with the forward-only code.
    const same = await request(app).patch(`/api/v1/orders/${orderId}/status`).set("Authorization", auth).send({ status: "cutting" });
    expect(same.status).toBe(409);
    expect((same.body as { code: string }).code).toBe("ORDER_STATUS_NOT_FORWARD");

    // Going BACKWARDS is rejected too.
    const back = await request(app).patch(`/api/v1/orders/${orderId}/status`).set("Authorization", auth).send({ status: "design_approved" });
    expect(back.status).toBe(409);
    expect((back.body as { code: string }).code).toBe("ORDER_STATUS_NOT_FORWARD");

    // Two concurrent advances to the SAME next stage: exactly one wins (row lock).
    const [a, b] = await Promise.all([
      request(app).patch(`/api/v1/orders/${orderId}/status`).set("Authorization", auth).send({ status: "stitching" }),
      request(app).patch(`/api/v1/orders/${orderId}/status`).set("Authorization", auth).send({ status: "stitching" }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);
  });
});
