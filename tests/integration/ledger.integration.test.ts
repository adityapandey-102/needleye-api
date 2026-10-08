import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { createApp } from "../../src/app";
import { authProvider } from "../../src/common/auth/supabase-auth-provider";
import { db } from "../../src/common/database/drizzle-client";
import { createFixtureUser, deleteFixtureOrder, deleteFixtureUser, closeDb, type FixtureUser } from "./helpers";

/**
 * The daily ledger (ADR 0008, phase 4) through the real app and database:
 * ledger_daily always equals a fresh recomputation from orders and payments,
 * whatever happens to them; months add up from it; and only the Owner and the
 * Accountant can read it.
 */
describe("ledger (integration)", () => {
  const app = createApp();
  const users: FixtureUser[] = [];
  const orderIds: string[] = [];
  let owner: FixtureUser, accountant: FixtureUser, designer: FixtureUser, master: FixtureUser;
  let ownerAuth = "";

  beforeAll(async () => {
    owner = await createFixtureUser("owner_manager", "Ledger Owner");
    accountant = await createFixtureUser("accountant", "Ledger Accountant");
    designer = await createFixtureUser("designer", "Ledger Designer");
    master = await createFixtureUser("master_tailor", "Ledger Master");
    users.push(owner, accountant, designer, master);
    ownerAuth = `Bearer ${(await authProvider.signInWithPassword(owner.email, owner.password)).accessToken}`;
  });

  afterEach(async () => {
    for (const id of orderIds.splice(0)) await deleteFixtureOrder(id);
  });

  afterAll(async () => {
    for (const u of users) await deleteFixtureUser(u.id);
    await closeDb();
  });

  /** Days where ledger_daily differs from a recomputation over orders + payments (expected: none). */
  async function driftedDays(): Promise<number> {
    const res = await db.execute(sql`
      with expected as (
        select day, sum(orders) as orders, sum(priced) as priced, sum(booked) as booked, sum(pob) as pob, sum(cash) as cash, sum(payments) as payments
        from (
          select o.booking_date as day, count(*) as orders, count(o.total_amount) as priced, coalesce(sum(o.total_amount), 0) as booked, 0::numeric as pob, 0::numeric as cash, 0 as payments
          from orders o group by 1
          union all
          select o.booking_date, 0, 0, 0, sum(p.amount), 0, 0 from payments p join orders o on o.id = p.order_id group by 1
          union all
          select p.paid_at, 0, 0, 0, 0, sum(p.amount), count(*) from payments p group by 1
        ) x group by day
      )
      select count(*)::int as n
      from expected e full join ledger_daily l on l.day = e.day
      where coalesce(e.orders, 0) <> coalesce(l.orders_booked, 0) or coalesce(e.priced, 0) <> coalesce(l.orders_priced, 0)
         or coalesce(e.booked, 0) <> coalesce(l.booked_total, 0) or coalesce(e.pob, 0) <> coalesce(l.paid_on_booked, 0)
         or coalesce(e.cash, 0) <> coalesce(l.cash_collected, 0) or coalesce(e.payments, 0) <> coalesce(l.payments_count, 0)
    `);
    return Number((res.rows[0] as { n: number }).n);
  }

  type Month = { month: string; ordersBooked: number; ordersNotPriced: number; total: string; paidSoFar: string; outstanding: string; cashCollected: string; paymentsCount: number };
  const month = async (m: string): Promise<Month> => {
    const res = await request(app).get(`/api/v1/ledger/months?from=${m}&to=${m}`).set("Authorization", ownerAuth);
    expect(res.status).toBe(200);
    return (res.body as { months: Month[] }).months[0]!;
  };
  const money = (s: string) => Number(s);

  it("stays equal to a recomputation through pricing, payments, edits, a moved booking date and removals", async () => {
    expect(await driftedDays()).toBe(0);
    const [mar, apr, feb] = await Promise.all([month("2005-03"), month("2005-04"), month("2005-02")]);

    const created = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", ownerAuth)
      .send({
        customerName: "Ledger Customer",
        phone: "9000000066",
        billNumber: `LED-${Date.now()}`,
        bookingDate: "2005-03-10",
        dueDate: "2041-06-01",
        designerId: designer.id,
        masterTailorId: master.id,
        productCategory: "saree",
        orderDetails: "ledger fixture",
        productionStatus: "design_pending",
      });
    expect(created.status).toBe(201);
    const id = (created.body as { order: { id: string; version: number } }).order.id;
    orderIds.push(id);

    // Booked, not priced yet.
    let m = await month("2005-03");
    expect(m.ordersBooked - mar.ordersBooked).toBe(1);
    expect(m.ordersNotPriced - mar.ordersNotPriced).toBe(1);

    await request(app).put(`/api/v1/orders/${id}/price`).set("Authorization", ownerAuth).send({ totalAmount: "10000" });
    const p1 = await request(app).post(`/api/v1/orders/${id}/payments`).set("Authorization", ownerAuth).send({ amount: "3000", method: "cash", paidAt: "2005-04-02" });
    await request(app).post(`/api/v1/orders/${id}/payments`).set("Authorization", ownerAuth).send({ amount: "1000", method: "upi", paidAt: "2005-04-20" });
    m = await month("2005-03");
    expect(money(m.total) - money(mar.total)).toBe(10000);
    expect(money(m.paidSoFar) - money(mar.paidSoFar)).toBe(4000);
    expect(money(m.outstanding) - money(mar.outstanding)).toBe(6000);
    const a = await month("2005-04");
    expect(money(a.cashCollected) - money(apr.cashCollected)).toBe(4000);
    expect(a.paymentsCount - apr.paymentsCount).toBe(2);
    expect(await driftedDays()).toBe(0);

    // Edit a payment's amount and date, discount the price, move the booking into February, remove a payment.
    const paymentId = (p1.body as { payment: { id: string } }).payment.id;
    await request(app).patch(`/api/v1/orders/${id}/payments/${paymentId}`).set("Authorization", ownerAuth).send({ amount: "3500", paidAt: "2005-03-28" });
    await request(app).put(`/api/v1/orders/${id}/price`).set("Authorization", ownerAuth).send({ totalAmount: "9000", reason: "Ledger test discount" });
    const current = (await request(app).get(`/api/v1/orders/${id}`).set("Authorization", ownerAuth)).body as { order: { version: number } };
    await request(app).patch(`/api/v1/orders/${id}`).set("Authorization", ownerAuth).send({ version: current.order.version, bookingDate: "2005-02-25" });
    const p2 = (await request(app).get(`/api/v1/orders/${id}/payments`).set("Authorization", ownerAuth)).body as { payments: { id: string; amount: string }[] };
    await request(app).delete(`/api/v1/orders/${id}/payments/${p2.payments.find((p) => p.amount === "1000.00")!.id}`).set("Authorization", ownerAuth);
    expect(await driftedDays()).toBe(0);

    const [mar2, apr2, feb2] = await Promise.all([month("2005-03"), month("2005-04"), month("2005-02")]);
    // The order now belongs to February: 9000 booked, 3500 paid on it.
    expect(money(feb2.total) - money(feb.total)).toBe(9000);
    expect(money(feb2.paidSoFar) - money(feb.paidSoFar)).toBe(3500);
    expect(mar2.ordersBooked).toBe(mar.ordersBooked);
    // Cash: 3500 is now dated 28 March, the 1000 on 20 April was removed.
    expect(money(mar2.cashCollected) - money(mar.cashCollected)).toBe(3500);
    expect(money(apr2.cashCollected)).toBe(money(apr.cashCollected));

    // A delivered order's payments are cleaned up past the lock in the fixture teardown -- the ledger follows that too.
    await request(app).patch(`/api/v1/orders/${id}/status`).set("Authorization", ownerAuth).send({ status: "ready" });
    await request(app).patch(`/api/v1/orders/${id}/status`).set("Authorization", ownerAuth).send({ status: "delivered" });
    await deleteFixtureOrder(orderIds.pop()!);
    expect(await driftedDays()).toBe(0);
  });

  it("months page newest first with zero months and range totals; export caps the range; Owner and Accountant only", async () => {
    const res = await request(app).get("/api/v1/ledger/months?from=2004-11&to=2005-04&limit=4&offset=0").set("Authorization", ownerAuth);
    expect(res.status).toBe(200);
    const body = res.body as { months: Month[]; total: number; totals: { total: string; cashCollected: string } };
    expect(body.total).toBe(6);
    expect(body.months.map((x) => x.month)).toEqual(["2005-04", "2005-03", "2005-02", "2005-01"]);

    const summary = await request(app).get("/api/v1/ledger/summary").set("Authorization", ownerAuth);
    expect(summary.status).toBe(200);
    expect((summary.body as { month: string; figures: { outstanding: string } }).figures.outstanding).toMatch(/^\d+\.\d{2}$/);

    const exp = await request(app).get("/api/v1/ledger/months/export?from=2005-01&to=2005-12").set("Authorization", ownerAuth);
    expect((exp.body as { months: Month[] }).months).toHaveLength(12);
    expect((await request(app).get("/api/v1/ledger/months/export?from=2001-01&to=2025-12").set("Authorization", ownerAuth)).status).toBe(400);
    expect((await request(app).get("/api/v1/ledger/months?from=2005-05&to=2005-01").set("Authorization", ownerAuth)).status).toBe(400);
    expect((await request(app).get("/api/v1/ledger/months?limit=500").set("Authorization", ownerAuth)).status).toBe(400);

    const accountantAuth = `Bearer ${(await authProvider.signInWithPassword(accountant.email, accountant.password)).accessToken}`;
    const designerAuth = `Bearer ${(await authProvider.signInWithPassword(designer.email, designer.password)).accessToken}`;
    expect((await request(app).get("/api/v1/ledger/summary").set("Authorization", accountantAuth)).status).toBe(200);
    expect((await request(app).get("/api/v1/ledger/summary").set("Authorization", designerAuth)).status).toBe(403);
    expect((await request(app).get("/api/v1/ledger/months").set("Authorization", designerAuth)).status).toBe(403);
  });
});
