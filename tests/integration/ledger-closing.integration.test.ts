import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { sql } from "drizzle-orm";
import { createApp } from "../../src/app";
import { authProvider } from "../../src/common/auth/supabase-auth-provider";
import { db } from "../../src/common/database/drizzle-client";
import { businessToday } from "../../src/common/time/business-date";
import { env } from "../../src/config/env";
import { createFixtureUser, deleteFixtureOrder, deleteFixtureUser, closeDb, type FixtureUser } from "./helpers";

/**
 * Closing the books and the check (ADR 0008, phase 5) through the real app
 * and database: a close keeps the month's figures; payments dated in a closed
 * month are refused by the API and by the database; a close and a payment
 * can't cross; only the Owner reopens, with a reason; and the check spots a
 * register that doesn't match the receipts, or a closed month that changed.
 * Uses months in 2003, which nothing else touches.
 */
describe("closing the books (integration)", () => {
  const app = createApp();
  const users: FixtureUser[] = [];
  const orderIds: string[] = [];
  const TEST_MONTHS = ["2003-05", "2003-06", "2003-07", "2003-08", "2003-09"];
  let owner: FixtureUser, accountant: FixtureUser, designer: FixtureUser, master: FixtureUser;
  let ownerAuth = "", accountantAuth = "", designerAuth = "";

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Reopens a test month left closed by an earlier, interrupted run (as the database owner). */
  async function ensureOpen(month: string): Promise<void> {
    await db.execute(sql`
      insert into ledger_month_closings (month, action, reason)
      select ${`${month}-01`}::date, 'reopened', 'Integration test reset'
      where public.ledger_month_closed(${`${month}-01`}::date)
    `);
  }

  /** The constraint a database error names, through Drizzle's wrapper. */
  function constraintOf(error: unknown): string | undefined {
    for (let e: unknown = error, i = 0; e && typeof e === "object" && i < 5; e = (e as { cause?: unknown }).cause, i++) {
      const c = (e as { constraint?: unknown }).constraint;
      if (typeof c === "string") return c;
    }
    return undefined;
  }

  beforeAll(async () => {
    owner = await createFixtureUser("owner_manager", "Closing Owner");
    accountant = await createFixtureUser("accountant", "Closing Accountant");
    designer = await createFixtureUser("designer", "Closing Designer");
    master = await createFixtureUser("master_tailor", "Closing Master");
    users.push(owner, accountant, designer, master);
    const token = async (u: FixtureUser) => `Bearer ${(await authProvider.signInWithPassword(u.email, u.password)).accessToken}`;
    [ownerAuth, accountantAuth, designerAuth] = await Promise.all([token(owner), token(accountant), token(designer)]);
    for (const m of TEST_MONTHS) await ensureOpen(m);
  });

  afterEach(async () => {
    for (const id of orderIds.splice(0)) await deleteFixtureOrder(id);
  });

  afterAll(async () => {
    for (const m of TEST_MONTHS) await ensureOpen(m);
    for (const u of users) await deleteFixtureUser(u.id);
    await closeDb();
  });

  /** A priced order booked on `bookingDate`. */
  async function pricedOrder(bookingDate: string, total: string): Promise<string> {
    const due = `2043-${String(1 + Math.floor(Math.random() * 12)).padStart(2, "0")}-${String(1 + Math.floor(Math.random() * 28)).padStart(2, "0")}`;
    const created = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", ownerAuth)
      .send({
        customerName: "Closing Customer",
        phone: "9000000077",
        billNumber: `CLS-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        bookingDate,
        dueDate: due,
        designerId: designer.id,
        masterTailorId: master.id,
        productCategory: "saree",
        orderDetails: "closing fixture",
        productionStatus: "design_pending",
      });
    expect(created.status).toBe(201);
    const id = (created.body as { order: { id: string } }).order.id;
    orderIds.push(id);
    expect((await request(app).put(`/api/v1/orders/${id}/price`).set("Authorization", ownerAuth).send({ totalAmount: total })).status).toBe(200);
    return id;
  }

  const pay = (orderId: string, amount: string, paidAt: string) =>
    request(app).post(`/api/v1/orders/${orderId}/payments`).set("Authorization", ownerAuth).send({ amount, method: "cash", paidAt });

  type Books = { status: "open" | "closed"; ended: boolean; closedAt: string | null; closedByName: string | null };
  type MonthRow = { month: string; total: string; cashCollected: string; paymentsCount: number; outstanding: string; books: Books };
  const month = async (m: string): Promise<MonthRow> => {
    const res = await request(app).get(`/api/v1/ledger/months?from=${m}&to=${m}`).set("Authorization", ownerAuth);
    expect(res.status).toBe(200);
    return (res.body as { months: MonthRow[] }).months[0]!;
  };

  it("a close keeps the month's figures and locks its payments -- in the API and the database -- until the Owner reopens it", async () => {
    const id = await pricedOrder("2003-05-10", "10000");
    const may = await pay(id, "2000", "2003-05-15");
    const june = await pay(id, "1000", "2003-06-03");
    expect([may.status, june.status]).toEqual([201, 201]);
    const mayPaymentId = (may.body as { payment: { id: string } }).payment.id;
    const junePaymentId = (june.body as { payment: { id: string } }).payment.id;

    const before = await month("2003-05");
    expect(before.books).toEqual({ status: "open", ended: true, closedAt: null, closedByName: null });

    // Who may close, and which months.
    expect((await request(app).post("/api/v1/ledger/months/2003-05/close").set("Authorization", designerAuth)).status).toBe(403);
    const thisMonth = businessToday(new Date(), env.BUSINESS_TIMEZONE).slice(0, 7);
    const running = await request(app).post(`/api/v1/ledger/months/${thisMonth}/close`).set("Authorization", accountantAuth);
    expect(running.status).toBe(409);
    expect((running.body as { code: string }).code).toBe("LEDGER_MONTH_NOT_FINISHED");
    expect((await request(app).post("/api/v1/ledger/months/2003-5/close").set("Authorization", accountantAuth)).status).toBe(400);

    // The Accountant closes May: the closing record is the month as it stands.
    const closed = await request(app).post("/api/v1/ledger/months/2003-05/close").set("Authorization", accountantAuth);
    expect(closed.status).toBe(201);
    const closing = (closed.body as { closing: { action: string; actorName: string; figures: { total: string; cashCollected: string; paymentsCount: number } } }).closing;
    expect(closing).toMatchObject({ action: "closed", actorName: "Closing Accountant" });
    expect(closing.figures).toMatchObject({ total: before.total, cashCollected: before.cashCollected, paymentsCount: before.paymentsCount });
    const again = await request(app).post("/api/v1/ledger/months/2003-05/close").set("Authorization", ownerAuth);
    expect((again.body as { code: string }).code).toBe("LEDGER_MONTH_ALREADY_CLOSED");
    expect((await month("2003-05")).books).toMatchObject({ status: "closed", closedByName: "Closing Accountant" });

    // Payments: May's is locked, June's isn't.
    const list = (await request(app).get(`/api/v1/orders/${id}/payments`).set("Authorization", ownerAuth)).body as { payments: { id: string; monthClosed: boolean }[] };
    expect(Object.fromEntries(list.payments.map((p) => [p.id, p.monthClosed]))).toEqual({ [mayPaymentId]: true, [junePaymentId]: false });

    const refused = [
      await pay(id, "100", "2003-05-20"),
      await request(app).patch(`/api/v1/orders/${id}/payments/${mayPaymentId}`).set("Authorization", ownerAuth).send({ amount: "2100" }),
      await request(app).patch(`/api/v1/orders/${id}/payments/${mayPaymentId}`).set("Authorization", ownerAuth).send({ notes: "just a note" }),
      // Moving June's payment INTO May is refused too.
      await request(app).patch(`/api/v1/orders/${id}/payments/${junePaymentId}`).set("Authorization", ownerAuth).send({ paidAt: "2003-05-25" }),
      await request(app).delete(`/api/v1/orders/${id}/payments/${mayPaymentId}`).set("Authorization", ownerAuth),
    ];
    expect(refused.map((r) => [r.status, (r.body as { code: string }).code])).toEqual(Array(5).fill([409, "PAYMENT_MONTH_CLOSED"]));
    expect((refused[0]!.body as { error: string }).error).toMatch(/May 2003 are closed/);

    // An open month's payment can still be corrected.
    expect((await request(app).patch(`/api/v1/orders/${id}/payments/${junePaymentId}`).set("Authorization", ownerAuth).send({ amount: "1500" })).status).toBe(200);

    // The database refuses too, whoever writes.
    const direct = await db
      .execute(sql`insert into payments (order_id, amount, method, paid_at, recorded_by) values (${id}::uuid, 50, 'cash', '2003-05-30', ${owner.id}::uuid)`)
      .then(() => "inserted", (e: unknown) => constraintOf(e));
    expect(direct).toBe("payments_month_closed");
    const directDelete = await db
      .execute(sql`delete from payments where id = ${mayPaymentId}::uuid`)
      .then(() => "deleted", (e: unknown) => constraintOf(e));
    expect(directDelete).toBe("payments_month_closed");

    // Closing freezes May's orders too: their prices can't be corrected (2026-10-09).
    const correction = await request(app).put(`/api/v1/orders/${id}/price`).set("Authorization", ownerAuth).send({ totalAmount: "9000", reason: "Closing test correction" });
    expect([correction.status, (correction.body as { code: string }).code]).toEqual([409, "ORDER_PRICE_MONTH_CLOSED"]);
    const books = (await request(app).get("/api/v1/ledger/months/2003-05/closings").set("Authorization", accountantAuth)).body as {
      books: Books;
      figuresNow: { total: string; cashCollected: string };
      history: { action: string; figures: { total: string } | null }[];
      total: number;
    };
    expect(books.books.status).toBe("closed");
    expect(books.figuresNow.total).toBe(before.total);
    expect(books.figuresNow.cashCollected).toBe(before.cashCollected);
    expect(books.history[0]).toMatchObject({ action: "closed", figures: { total: before.total } });

    // Reopen: Owner only, with a reason.
    expect((await request(app).post("/api/v1/ledger/months/2003-05/reopen").set("Authorization", accountantAuth).send({ reason: "Fix an entry" })).status).toBe(403);
    const noReason = await request(app).post("/api/v1/ledger/months/2003-05/reopen").set("Authorization", ownerAuth).send({});
    expect([noReason.status, (noReason.body as { code: string }).code]).toEqual([400, "LEDGER_REOPEN_REASON_REQUIRED"]);
    const reopened = await request(app).post("/api/v1/ledger/months/2003-05/reopen").set("Authorization", ownerAuth).send({ reason: "Integration test: correct an entry" });
    expect(reopened.status).toBe(201);
    expect((reopened.body as { closing: { action: string; reason: string; actorName: string } }).closing).toMatchObject({
      action: "reopened",
      reason: "Integration test: correct an entry",
      actorName: "Closing Owner",
    });
    const notClosed = await request(app).post("/api/v1/ledger/months/2003-05/reopen").set("Authorization", ownerAuth).send({ reason: "Again" });
    expect((notClosed.body as { code: string }).code).toBe("LEDGER_MONTH_NOT_CLOSED");

    expect((await pay(id, "100", "2003-05-20")).status).toBe(201);
    expect((await month("2003-05")).books.status).toBe("open");
    const history = (await request(app).get("/api/v1/ledger/months/2003-05/closings").set("Authorization", ownerAuth)).body as { history: { action: string }[] };
    expect(history.history.slice(0, 2).map((h) => h.action)).toEqual(["reopened", "closed"]);
  });

  it("a close waits for a payment already in flight and counts it; a payment waiting on a close is then refused", async () => {
    const id = await pricedOrder("2003-07-01", "10000");
    expect((await pay(id, "1000", "2003-07-05")).status).toBe(201);
    const july = await month("2003-07");

    // A payment in flight in July: its transaction holds July's shared lock until it commits.
    const inFlight = db.transaction(async (tx) => {
      await tx.execute(sql`insert into payments (order_id, amount, method, paid_at, recorded_by) values (${id}::uuid, 700, 'cash', '2003-07-09', ${owner.id}::uuid)`);
      await sleep(600);
    });
    await sleep(150);
    const [, closed] = await Promise.all([inFlight, request(app).post("/api/v1/ledger/months/2003-07/close").set("Authorization", accountantAuth)]);
    expect(closed.status).toBe(201);
    const figures = (closed.body as { closing: { figures: { cashCollected: string; paymentsCount: number } } }).closing.figures;
    expect(Number(figures.cashCollected)).toBe(Number(july.cashCollected) + 700);
    expect(figures.paymentsCount).toBe(july.paymentsCount + 1);

    // A close in progress in August (its exclusive lock held); a payment arrives, waits -- and is refused once the close commits.
    const closing = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(4203, public.ledger_month_key('2003-08-01'::date))`);
      await sleep(600);
      await tx.execute(sql`
        insert into ledger_month_closings (month, action, orders_booked, orders_priced, booked_total, paid_on_booked, cash_collected, payments_count, reason)
        values ('2003-08-01', 'closed', 0, 0, 0, 0, 0, 0, null)
      `);
    });
    await sleep(150);
    const [, waited] = await Promise.all([closing, pay(id, "100", "2003-08-05")]);
    expect([waited.status, (waited.body as { code: string }).code]).toEqual([409, "PAYMENT_MONTH_CLOSED"]);

    for (const m of ["2003-07", "2003-08"]) {
      expect((await request(app).post(`/api/v1/ledger/months/${m}/reopen`).set("Authorization", ownerAuth).send({ reason: "Integration test cleanup" })).status).toBe(201);
    }
  });

  it("the check: verified when the register matches; it names mismatched days and a closed month whose cash changed", async () => {
    const ok = await request(app).post("/api/v1/ledger/reconciliations").set("Authorization", accountantAuth);
    expect(ok.status).toBe(201);
    const okBody = ok.body as { latest: { status: string; kind: string; requestedByName: string; daysChecked: number }; timeZone: string };
    expect(okBody.latest).toMatchObject({ status: "verified", kind: "manual", requestedByName: "Closing Accountant" });
    expect(okBody.latest.daysChecked).toBeGreaterThan(0);

    expect((await request(app).post("/api/v1/ledger/months/2003-09/close").set("Authorization", ownerAuth)).status).toBe(201);
    // Tamper with the register as the database owner: a day in closed September that no receipt explains.
    await db.execute(sql`
      insert into ledger_daily (day, orders_booked, orders_priced, booked_total, paid_on_booked, cash_collected, payments_count, updated_at)
      values ('2003-09-15', 0, 0, 0, 0, 50, 1, now())
    `);
    try {
      const bad = await request(app).post("/api/v1/ledger/reconciliations").set("Authorization", ownerAuth);
      expect(bad.status).toBe(201);
      const latest = (bad.body as {
        latest: {
          status: string;
          mismatchedDays: number;
          mismatches: { day: string; fields: { field: string; register: string; actual: string }[] }[];
          closedMonthDrift: number;
          closedMonths: { month: string; closedCash: string; cashNow: string }[];
        };
      }).latest;
      expect(latest.status).toBe("problems");
      expect(latest.mismatches.find((m) => m.day === "2003-09-15")?.fields).toEqual([
        { field: "cashCollected", register: "50.00", actual: "0.00" },
        { field: "paymentsCount", register: "1", actual: "0" },
      ]);
      expect(latest.closedMonths).toContainEqual(expect.objectContaining({ month: "2003-09", closedCash: "0.00", cashNow: "50.00" }));

      const seen = (await request(app).get("/api/v1/ledger/reconciliations/latest").set("Authorization", accountantAuth)).body as { latest: { status: string } };
      expect(seen.latest.status).toBe("problems");
    } finally {
      await db.execute(sql`delete from ledger_daily where day = '2003-09-15'`);
      await request(app).post("/api/v1/ledger/months/2003-09/reopen").set("Authorization", ownerAuth).send({ reason: "Integration test cleanup" });
    }
    const fixed = await request(app).post("/api/v1/ledger/reconciliations").set("Authorization", ownerAuth);
    expect((fixed.body as { latest: { status: string } }).latest.status).toBe("verified");
  });

  it("the check runs every night at 02:00 IST, one at a time; Owner and Accountant only", async () => {
    const job = await db.execute(sql`select schedule, command from cron.job where jobname = 'needleye-ledger-reconcile'`);
    expect(job.rows[0]).toEqual({ schedule: "30 20 * * *", command: "select public.ledger_reconcile('nightly')" });

    // Another check holding the key: "Verify now" says so instead of queueing.
    const busy = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(4204, 0)`);
      await sleep(500);
    });
    await sleep(150);
    const [, refused] = await Promise.all([busy, request(app).post("/api/v1/ledger/reconciliations").set("Authorization", ownerAuth)]);
    expect([refused.status, (refused.body as { code: string }).code]).toEqual([409, "LEDGER_CHECK_RUNNING"]);

    expect((await request(app).get("/api/v1/ledger/reconciliations/latest").set("Authorization", designerAuth)).status).toBe(403);
    expect((await request(app).post("/api/v1/ledger/reconciliations").set("Authorization", designerAuth)).status).toBe(403);
    expect((await request(app).get("/api/v1/ledger/months/2003-05/closings").set("Authorization", designerAuth)).status).toBe(403);
    expect((await request(app).post("/api/v1/ledger/months/2003-05/reopen").set("Authorization", designerAuth).send({ reason: "nope" })).status).toBe(403);
  });

  it("nobody outside the app can call the register functions over Supabase's API roles", async () => {
    const res = await db.execute(sql`
      select has_function_privilege('anon', 'public.ledger_apply(jsonb)', 'execute') as anon_apply,
             has_function_privilege('authenticated', 'public.ledger_apply(jsonb)', 'execute') as auth_apply,
             has_function_privilege('anon', 'public.ledger_reconcile(text, uuid)', 'execute') as anon_reconcile,
             has_function_privilege('authenticated', 'public.ledger_reconcile(text, uuid)', 'execute') as auth_reconcile
    `);
    expect(res.rows[0]).toEqual({ anon_apply: false, auth_apply: false, anon_reconcile: false, auth_reconcile: false });
  });
});
