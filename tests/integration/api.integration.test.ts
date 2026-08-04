import { afterAll, afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { createApp } from "../../src/app";
import { authProvider } from "../../src/common/auth/supabase-auth-provider";
import { db } from "../../src/common/database/drizzle-client";
import { auditLog } from "../../src/common/audit/audit-log.schema";
import { AUDIT_ACTIONS } from "../../src/common/audit/audit-actions";
import { createFixtureUser, deleteFixtureUser, deleteFixtureOrder, closeDb } from "./helpers";

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

    // Creating the order wrote a business audit record, attributed to the
    // acting designer and correlated with a request id.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, orderId), eq(auditLog.action, AUDIT_ACTIONS.ORDER_CREATED)));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.actorId).toBe(designer.id);
    expect(auditRows[0]?.entityType).toBe("order");
    expect(auditRows[0]?.requestId).toBeTruthy();
  });

  it("rejects lowering an order's total below what's already been collected (no overpaid state)", async () => {
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

    // Lowering the total to ₹500 (below the ₹600 collected) is rejected...
    const badRes = await request(app)
      .patch(`/api/v1/orders/${orderId}`)
      .set("Authorization", auth)
      .send({ totalAmount: 500 });
    expect(badRes.status).toBe(400);
    expect((badRes.body as { code: string }).code).toBe("ORDER_TOTAL_BELOW_PAID");

    // ...but lowering to ₹800 (still >= ₹600) is fine, and re-derives to advance_paid.
    const okRes = await request(app)
      .patch(`/api/v1/orders/${orderId}`)
      .set("Authorization", auth)
      .send({ totalAmount: 800 });
    expect(okRes.status).toBe(200);
    expect((okRes.body as { order: { paymentStatus: string; totalAmount: number } }).order.paymentStatus).toBe("advance_paid");
    expect((okRes.body as { order: { totalAmount: number } }).order.totalAmount).toBe(800);
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

    // ...but cannot change its status, and cannot see its payment ledger.
    const patch = await request(app).patch(`/api/v1/orders/${orderId}/status`).set("Authorization", auth).send({ status: "cutting" });
    expect(patch.status).toBe(403);
    const ledger = await request(app).get(`/api/v1/orders/${orderId}/payments`).set("Authorization", auth);
    expect(ledger.status).toBe(403);
  });
});
