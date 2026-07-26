import { afterAll, afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authProvider } from "../../src/common/auth/supabase-auth-provider";
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
});
