import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { createApp } from "../../src/app";
import { authProvider } from "../../src/common/auth/supabase-auth-provider";
import { db } from "../../src/common/database/drizzle-client";
import { orders } from "../../src/modules/orders/infrastructure/order.schema";
import { orderPriceHistory } from "../../src/modules/orders/infrastructure/order-price-history.schema";
import { payments } from "../../src/modules/payments/infrastructure/payments.schema";
import { businessToday } from "../../src/common/time/business-date";
import { env } from "../../src/config/env";
import { createFixtureUser, deleteFixtureOrder, deleteFixtureUser, closeDb, type FixtureUser } from "./helpers";

/**
 * Pricing and payment rules (ADR 0008, phase 2) through the real app and the
 * real database: orders start unpriced; the price is set / raised / discounted
 * only via PUT /orders/:id/price by the right roles; payments need a price;
 * Delivered needs a price; delivery locks the price and the payments; and the
 * database refuses the same things when a write skips the API.
 */
describe("pricing & payment rules (integration)", () => {
  const app = createApp();
  const users: FixtureUser[] = [];
  const orderIds: string[] = [];
  let owner: FixtureUser, accountant: FixtureUser, designer: FixtureUser, otherDesigner: FixtureUser, pm: FixtureUser, master: FixtureUser;
  const tokens: Record<string, string> = {};

  type Json = Record<string, unknown>;
  const as = (who: string) => ({ Authorization: `Bearer ${tokens[who]}` });
  const body = <T = Json>(res: { body: unknown }) => res.body as T;

  beforeAll(async () => {
    owner = await createFixtureUser("owner_manager", "Pricing Owner");
    accountant = await createFixtureUser("accountant", "Pricing Accountant");
    designer = await createFixtureUser("designer", "Pricing Designer");
    otherDesigner = await createFixtureUser("designer", "Pricing Other Designer");
    pm = await createFixtureUser("production_manager", "Pricing PM");
    master = await createFixtureUser("master_tailor", "Pricing Master");
    users.push(owner, accountant, designer, otherDesigner, pm, master);
    for (const [name, u] of Object.entries({ owner, accountant, designer, otherDesigner, pm, master })) {
      tokens[name] = (await authProvider.signInWithPassword(u.email, u.password)).accessToken;
    }
  });

  afterEach(async () => {
    for (const id of orderIds.splice(0)) await deleteFixtureOrder(id);
  });

  afterAll(async () => {
    for (const u of users) await deleteFixtureUser(u.id);
    await closeDb();
  });

  const freeDay = () => new Date(Date.UTC(2041, 0, 1) + Math.floor(Math.random() * 3650) * 86_400_000).toISOString().slice(0, 10);

  async function newOrder(by = "designer", extra: Json = {}) {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(as(by))
      .send({
        customerName: "Pricing Customer",
        phone: "9000000077",
        billNumber: `PRICE-${Date.now()}-${Math.random()}`,
        dueDate: freeDay(),
        designerId: designer.id,
        masterTailorId: master.id,
        productCategory: "saree",
        orderDetails: "pricing fixture",
        productionStatus: "design_pending",
        ...extra,
      });
    if (res.status === 201) orderIds.push(body<{ order: { id: string } }>(res).order.id);
    return res;
  }
  const price = (id: string, who: string, totalAmount: number | string, reason?: string) =>
    request(app).put(`/api/v1/orders/${id}/price`).set(as(who)).send(reason === undefined ? { totalAmount } : { totalAmount, reason });
  const pay = (id: string, who: string, amount: number, extra: Json = {}) =>
    request(app).post(`/api/v1/orders/${id}/payments`).set(as(who)).send({ amount, method: "cash", ...extra });
  const stage = (id: string, status: string) => request(app).patch(`/api/v1/orders/${id}/status`).set(as("owner")).send({ status });
  const code = (res: { body: unknown }) => body<{ code: string }>(res).code;

  it("a new order has no price: not_priced, no outstanding, its own bucket and count, and takes no payments", async () => {
    const res = await newOrder();
    expect(res.status).toBe(201);
    const order = body<{ order: Json & { id: string } }>(res).order;
    expect(order).toMatchObject({ totalAmount: null, outstanding: null, paymentStatus: "not_priced", priceSet: false });

    const ids = async (bucket: string) =>
      body<{ orders: { id: string }[] }>(await request(app).get(`/api/v1/orders?bucket=${bucket}&limit=100`).set(as("designer"))).orders.map((o) => o.id);
    expect(await ids("not_priced")).toContain(order.id);
    expect(await ids("pending_payment")).not.toContain(order.id);
    const stats = body<{ notPriced: number }>(await request(app).get("/api/v1/orders/stats").set(as("designer")));
    expect(stats.notPriced).toBeGreaterThanOrEqual(1);

    const payment = await pay(order.id, "designer", 100);
    expect(payment.status).toBe(409);
    expect(code(payment)).toBe("PAYMENT_ORDER_NOT_PRICED");

    // The PM sees whether it's priced (not the amount).
    const asPm = body<{ order: Json }>(await request(app).get(`/api/v1/orders/${order.id}`).set(as("pm"))).order;
    expect(asPm.priceSet).toBe(false);
    expect(asPm.totalAmount).toBeUndefined();
  });

  it("first price: the order's designer (own orders only), owner or accountant -- not the PM or master", async () => {
    const id = body<{ order: { id: string } }>(await newOrder()).order.id;
    for (const who of ["pm", "master", "otherDesigner"]) {
      const res = await price(id, who, 5000);
      expect(res.status, who).toBe(403);
    }
    const set = await price(id, "designer", 5000);
    expect(set.status).toBe(200);
    expect(body<{ order: Json; change: Json }>(set)).toMatchObject({
      order: { totalAmount: "5000.00", paymentStatus: "unpaid", priceSet: true, outstanding: "5000.00" },
      change: { kind: "set", previousTotal: null, newTotal: "5000.00", collected: "0.00" },
    });

    // Once set, the designer can't change it -- not even upwards.
    const raise = await price(id, "designer", 6000, "More hand work");
    expect(raise.status).toBe(403);
    expect(code(raise)).toBe("ORDER_PRICE_FORBIDDEN");
  });

  it("raise and discount: owner / accountant with a reason; a discount never below what's collected", async () => {
    const id = body<{ order: { id: string } }>(await newOrder()).order.id;
    expect((await price(id, "accountant", 10000)).status).toBe(200);
    expect((await pay(id, "designer", 4000)).status).toBe(201);

    const noReason = await price(id, "accountant", 12000);
    expect(noReason.status).toBe(400);
    expect(code(noReason)).toBe("ORDER_PRICE_REASON_REQUIRED");
    expect(body<{ change: Json }>(await price(id, "accountant", 12000, "Extra embroidery")).change).toMatchObject({ kind: "raise" });

    const tooLow = await price(id, "owner", 3999, "Big discount");
    expect(tooLow.status).toBe(400);
    expect(code(tooLow)).toBe("ORDER_TOTAL_BELOW_PAID");
    const unchanged = await price(id, "owner", 12000, "Same");
    expect(code(unchanged)).toBe("ORDER_PRICE_UNCHANGED");

    const toPaid = await price(id, "owner", 4000, "Settled at what was paid");
    expect(body<{ order: Json }>(toPaid).order).toMatchObject({ totalAmount: "4000.00", paymentStatus: "fully_paid", nextPaymentDate: null });

    const history = body<{ history: { kind: string; reason: string | null; changedByName: string | null }[] }>(
      await request(app).get(`/api/v1/orders/${id}/price-history`).set(as("designer")),
    ).history;
    expect(history.map((h) => h.kind)).toEqual(["discount", "raise", "set"]);
    expect(history[0]).toMatchObject({ reason: "Settled at what was paid", changedByName: "Pricing Owner" });
    expect((await request(app).get(`/api/v1/orders/${id}/price-history`).set(as("master"))).status).toBe(403);
  });

  it("a price at booking: allowed for the order's own designer (recorded as its first price), refused for the PM", async () => {
    const own = await newOrder("designer", { totalAmount: 2500 });
    expect(own.status).toBe(201);
    const id = body<{ order: { id: string } }>(own).order.id;
    const rows = await db.select().from(orderPriceHistory).where(eq(orderPriceHistory.orderId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "set", newTotal: "2500.00", previousTotal: null });

    const byPm = await newOrder("pm", { totalAmount: 2500 });
    expect(byPm.status).toBe(403);
    expect(code(byPm)).toBe("ORDER_PRICE_FORBIDDEN");
  });

  it("payments: designers record; only owner / accountant edit or delete; no future dates", async () => {
    const id = body<{ order: { id: string } }>(await newOrder()).order.id;
    await price(id, "owner", 3000);
    const recorded = await pay(id, "designer", 1000);
    expect(recorded.status).toBe(201);
    const paymentId = body<{ payment: { id: string } }>(recorded).payment.id;

    expect((await request(app).patch(`/api/v1/orders/${id}/payments/${paymentId}`).set(as("designer")).send({ amount: 900 })).status).toBe(403);
    expect((await request(app).delete(`/api/v1/orders/${id}/payments/${paymentId}`).set(as("designer"))).status).toBe(403);
    expect((await request(app).patch(`/api/v1/orders/${id}/payments/${paymentId}`).set(as("accountant")).send({ amount: 900 })).status).toBe(200);

    const tomorrow = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    expect(tomorrow > businessToday(new Date(), env.BUSINESS_TIMEZONE)).toBe(true);
    const future = await pay(id, "designer", 100, { paidAt: tomorrow });
    expect(future.status).toBe(400);
    expect(code(future)).toBe("PAYMENT_DATE_INVALID");
    const fake = await pay(id, "designer", 100, { paidAt: "2026-02-31" });
    expect(fake.status).toBe(400);
  });

  it("Delivered needs a price; delivery then locks the price and the payments (new payments still allowed)", async () => {
    const id = body<{ order: { id: string } }>(await newOrder()).order.id;
    expect((await stage(id, "ready")).status).toBe(200);
    const unpriced = await stage(id, "delivered");
    expect(unpriced.status).toBe(409);
    expect(code(unpriced)).toBe("ORDER_PRICE_REQUIRED");

    await price(id, "owner", 5000);
    const paymentId = body<{ payment: { id: string } }>(await pay(id, "designer", 1000)).payment.id;
    expect((await stage(id, "delivered")).status).toBe(200);

    const locked = await price(id, "owner", 4500, "After delivery");
    expect(locked.status).toBe(409);
    expect(code(locked)).toBe("ORDER_PRICE_LOCKED");
    const edit = await request(app).patch(`/api/v1/orders/${id}/payments/${paymentId}`).set(as("owner")).send({ amount: 1200 });
    expect(edit.status).toBe(409);
    expect(code(edit)).toBe("PAYMENT_LOCKED_AFTER_DELIVERY");
    expect((await request(app).delete(`/api/v1/orders/${id}/payments/${paymentId}`).set(as("owner"))).status).toBe(409);
    // The balance can still be collected after delivery.
    expect((await pay(id, "designer", 4000)).status).toBe(201);
  });

  it("the database refuses the same things when a write skips the API", async () => {
    const id = body<{ order: { id: string } }>(await newOrder()).order.id;
    // No payment without a price.
    await expect(
      db.insert(payments).values({ orderId: id, amount: "100.00", method: "cash", paidAt: "2026-10-01", recordedBy: owner.id }),
    ).rejects.toThrow();
    await price(id, "owner", 1000);
    await db.insert(payments).values({ orderId: id, amount: "600.00", method: "cash", paidAt: "2026-10-01", recordedBy: owner.id });
    // Payments never sum past the total; the total never drops below them.
    await expect(
      db.insert(payments).values({ orderId: id, amount: "500.00", method: "cash", paidAt: "2026-10-01", recordedBy: owner.id }),
    ).rejects.toThrow();
    await expect(db.update(orders).set({ totalAmount: "500.00" }).where(eq(orders.id, id))).rejects.toThrow();
    // An order with payments can't be deleted (no cascade).
    await expect(db.delete(orders).where(eq(orders.id, id))).rejects.toThrow();
    // Price history is append-only.
    await expect(db.update(orderPriceHistory).set({ reason: "rewritten" }).where(eq(orderPriceHistory.orderId, id))).rejects.toThrow();
    await expect(db.delete(orderPriceHistory).where(eq(orderPriceHistory.orderId, id))).rejects.toThrow();
    // Delivered locks the price and the payments.
    await stage(id, "ready");
    await stage(id, "delivered");
    await expect(db.update(orders).set({ totalAmount: "2000.00" }).where(eq(orders.id, id))).rejects.toThrow();
    await expect(db.update(payments).set({ amount: "700.00" }).where(eq(payments.orderId, id))).rejects.toThrow();
    await expect(db.delete(payments).where(eq(payments.orderId, id))).rejects.toThrow();
    // ...and a not-priced order can't be delivered even by a direct write.
    const other = body<{ order: { id: string } }>(await newOrder()).order.id;
    await stage(other, "ready");
    await expect(db.execute(sql`update orders set production_status = 'delivered' where id = ${other}`)).rejects.toThrow();
  });
});
