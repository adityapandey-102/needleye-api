import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, asc, desc, eq } from "drizzle-orm";
import { createApp } from "../../src/app";
import { authProvider } from "../../src/common/auth/supabase-auth-provider";
import { db } from "../../src/common/database/drizzle-client";
import { orderAuditLog } from "../../src/modules/orders/infrastructure/order-audit-log.schema";
import { orderStatusHistory } from "../../src/modules/orders/infrastructure/order-status-history.schema";
import { paymentAuditLog } from "../../src/modules/payments/infrastructure/payment-audit-log.schema";
import { DrizzleOrdersRepository } from "../../src/modules/orders/infrastructure/drizzle-orders.repository";
import { businessToday } from "../../src/common/time/business-date";
import { env } from "../../src/config/env";
import { createFixtureUser, deleteFixtureOrder, deleteFixtureUser, closeDb, type FixtureUser } from "./helpers";

/**
 * The split audit logs (ADR 0008, phase 3), through the real app and database:
 * every order / payment change writes its own typed log row in the same
 * transaction; edits record before -> after; the logs refuse updates and
 * deletes; and the owner's daily activity reads them by category.
 */
describe("audit logs (integration)", () => {
  const app = createApp();
  const repo = new DrizzleOrdersRepository();
  const users: FixtureUser[] = [];
  const orderIds: string[] = [];
  let owner: FixtureUser, designer: FixtureUser, otherDesigner: FixtureUser, master: FixtureUser;
  let ownerAuth = "";

  beforeAll(async () => {
    owner = await createFixtureUser("owner_manager", "Audit Owner");
    designer = await createFixtureUser("designer", "Audit Designer");
    otherDesigner = await createFixtureUser("designer", "Audit Second Designer");
    master = await createFixtureUser("master_tailor", "Audit Master");
    users.push(owner, designer, otherDesigner, master);
    ownerAuth = `Bearer ${(await authProvider.signInWithPassword(owner.email, owner.password)).accessToken}`;
  });

  afterEach(async () => {
    for (const id of orderIds.splice(0)) await deleteFixtureOrder(id);
  });

  afterAll(async () => {
    for (const u of users) await deleteFixtureUser(u.id);
    await closeDb();
  });

  const freeDay = () => new Date(Date.UTC(2042, 0, 1) + Math.floor(Math.random() * 3650) * 86_400_000).toISOString().slice(0, 10);

  async function newOrder(extra: Record<string, unknown> = {}): Promise<{ id: string; version: number; orderNumber: string }> {
    const res = await request(app)
      .post("/api/v1/orders")
      .set("Authorization", ownerAuth)
      .send({
        customerName: "Audit Customer",
        phone: "9000000055",
        billNumber: `AUD-${Date.now()}-${Math.random()}`,
        dueDate: freeDay(),
        designerId: designer.id,
        masterTailorId: master.id,
        productCategory: "saree",
        orderDetails: "audit fixture",
        totalAmount: "3000.00",
        productionStatus: "design_pending",
        ...extra,
      });
    expect(res.status).toBe(201);
    const order = (res.body as { order: { id: string; version: number; orderNumber: string } }).order;
    orderIds.push(order.id);
    return order;
  }
  const orderLog = (orderId: string) =>
    db.select().from(orderAuditLog).where(eq(orderAuditLog.orderId, orderId)).orderBy(asc(orderAuditLog.createdAt));

  it("a payment's record / edit / removal each write a typed log row, with the previous values on an edit", async () => {
    const { id } = await newOrder();
    const recorded = await request(app).post(`/api/v1/orders/${id}/payments`).set("Authorization", ownerAuth).send({ amount: "1000", method: "upi", notes: "advance" });
    expect(recorded.status).toBe(201);
    const paymentId = (recorded.body as { payment: { id: string; paidAt: string } }).payment.id;
    const today = businessToday(new Date(), env.BUSINESS_TIMEZONE);

    await request(app).patch(`/api/v1/orders/${id}/payments/${paymentId}`).set("Authorization", ownerAuth).send({ amount: "1200", method: "cash" });
    // Saving the same values again changes nothing -> no row.
    await request(app).patch(`/api/v1/orders/${id}/payments/${paymentId}`).set("Authorization", ownerAuth).send({ amount: "1200" });
    await request(app).delete(`/api/v1/orders/${id}/payments/${paymentId}`).set("Authorization", ownerAuth);

    const rows = await db.select().from(paymentAuditLog).where(eq(paymentAuditLog.orderId, id)).orderBy(asc(paymentAuditLog.createdAt));
    expect(rows.map((r) => r.action)).toEqual(["created", "updated", "deleted"]);
    expect(rows[0]).toMatchObject({ paymentId, amount: "1000.00", method: "upi", paidAt: today, notes: "advance", actorId: owner.id, previousAmount: null });
    expect(rows[1]).toMatchObject({ amount: "1200.00", method: "cash", previousAmount: "1000.00", previousMethod: "upi", previousPaidAt: today });
    expect(rows[2]).toMatchObject({ amount: "1200.00", method: "cash", paidAt: today });
    expect(rows.every((r) => r.requestId)).toBe(true);
  });

  it("an order edit logs each changed field before -> after (people by name too); a no-op save logs nothing", async () => {
    const order = await newOrder({ specialNotes: "" });
    const created = await orderLog(order.id);
    expect(created.map((r) => r.action)).toEqual(["created"]);
    expect(created[0]).toMatchObject({ actorId: owner.id });

    const newDue = freeDay();
    const edit = await request(app)
      .patch(`/api/v1/orders/${order.id}`)
      .set("Authorization", ownerAuth)
      .send({ version: order.version, customerName: "Audit Customer", dueDate: newDue, designerId: otherDesigner.id, handWork: true, specialNotes: "Rush" });
    expect(edit.status).toBe(200);
    const version = (edit.body as { order: { version: number } }).order.version;

    // The same values again: saved, but nothing changed -> no new row.
    await request(app).patch(`/api/v1/orders/${order.id}`).set("Authorization", ownerAuth).send({ version, dueDate: newDue, handWork: true });
    // A stale version is refused -> nothing written either.
    const stale = await request(app).patch(`/api/v1/orders/${order.id}`).set("Authorization", ownerAuth).send({ version: order.version, phone: "9111111111" });
    expect(stale.status).toBe(409);

    const rows = await orderLog(order.id);
    expect(rows.map((r) => r.action)).toEqual(["created", "updated"]);
    const changes = rows[1]!.changes!;
    expect(Object.keys(changes).sort()).toEqual(["designerId", "dueDate", "handWork", "specialNotes"]); // jsonb keeps no key order
    expect(changes.dueDate?.to).toBe(newDue);
    expect(changes.designerId).toEqual({ from: designer.id, to: otherDesigner.id, fromLabel: "Audit Designer", toLabel: "Audit Second Designer" });
    expect(changes.handWork).toEqual({ from: false, to: true });
    expect(changes.specialNotes).toEqual({ from: null, to: "Rush" });
  });

  it("a stage move records where it came from; the first row has none", async () => {
    const { id } = await newOrder();
    await request(app).patch(`/api/v1/orders/${id}/status`).set("Authorization", ownerAuth).send({ status: "cutting" });
    const history = await db.select().from(orderStatusHistory).where(eq(orderStatusHistory.orderId, id)).orderBy(asc(orderStatusHistory.createdAt));
    expect(history.map((h) => [h.fromStatus, h.status])).toEqual([
      [null, "design_pending"],
      ["design_pending", "cutting"],
    ]);
  });

  it("removing a reference image is logged with the slot", async () => {
    const { id } = await newOrder();
    await repo.upsertImage({ orderId: id, slot: 2, storagePath: `test/${id}/2.jpg`, originalFilename: null, contentType: "image/jpeg", sizeBytes: 1, uploadedBy: owner.id });
    await repo.deleteImage(id, 2, owner.id);
    await repo.deleteImage(id, 2, owner.id); // already gone: nothing to log
    const rows = (await orderLog(id)).filter((r) => r.action === "image_deleted");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ details: { slot: 2 }, actorId: owner.id });
  });

  it("the logs are append-only", async () => {
    const { id } = await newOrder();
    await request(app).post(`/api/v1/orders/${id}/payments`).set("Authorization", ownerAuth).send({ amount: "100", method: "cash" });
    await expect(db.update(orderAuditLog).set({ details: { forged: true } }).where(eq(orderAuditLog.orderId, id))).rejects.toThrow();
    await expect(db.delete(orderAuditLog).where(eq(orderAuditLog.orderId, id))).rejects.toThrow();
    await expect(db.update(paymentAuditLog).set({ amount: "1.00" }).where(eq(paymentAuditLog.orderId, id))).rejects.toThrow();
    await expect(db.delete(paymentAuditLog).where(eq(paymentAuditLog.orderId, id))).rejects.toThrow();
  });

  it("daily activity: one category at a time, newest first, with every category's count", async () => {
    const order = await newOrder({ totalAmount: null });
    await request(app).put(`/api/v1/orders/${order.id}/price`).set("Authorization", ownerAuth).send({ totalAmount: "5000" });
    await request(app).patch(`/api/v1/orders/${order.id}/status`).set("Authorization", ownerAuth).send({ status: "stitching" });
    await request(app).post(`/api/v1/orders/${order.id}/payments`).set("Authorization", ownerAuth).send({ amount: "2000", method: "card" });

    const today = businessToday(new Date(), env.BUSINESS_TIMEZONE);
    type Feed = { counts: Record<string, number>; total: number; events: { kind: string; orderId: string | null; orderNumber: string | null; actorName: string | null; details: Record<string, unknown> | null }[] };
    const feed = async (category: string) =>
      (await request(app).get(`/api/v1/reports/activity?day=${today}&category=${category}&limit=100`).set("Authorization", ownerAuth)).body as Feed;

    const orders = await feed("orders");
    const mine = orders.events.filter((e) => e.orderId === order.id);
    expect(mine.map((e) => e.kind)).toEqual(["price.set", "order.created"]);
    expect(mine[0]).toMatchObject({ orderNumber: order.orderNumber, actorName: "Audit Owner", details: { newTotal: "5000.00", collected: "0.00" } });
    expect(orders.total).toBe(orders.counts.orders);

    const stages = (await feed("stages")).events.filter((e) => e.orderId === order.id);
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({ kind: "stage.moved", details: { from: "design_pending", to: "stitching" } });

    const payments = (await feed("payments")).events.filter((e) => e.orderId === order.id);
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ kind: "payment.created", details: { amount: "2000.00", method: "card", paidAt: today } });

    // Paging: limit 1 returns one event and the full total.
    const one = (await request(app).get(`/api/v1/reports/activity?day=${today}&category=orders&limit=1`).set("Authorization", ownerAuth)).body as Feed;
    expect(one.events).toHaveLength(1);
    expect(one.total).toBe(orders.total);
  });

  it("the staff 'last seen' counts actions in every log, not just sign-ins", async () => {
    const { id } = await newOrder();
    const designerAuth = `Bearer ${(await authProvider.signInWithPassword(designer.email, designer.password)).accessToken}`;
    await request(app).patch(`/api/v1/orders/${id}/status`).set("Authorization", designerAuth).send({ status: "design_approved" });
    const [move] = await db
      .select({ at: orderStatusHistory.createdAt })
      .from(orderStatusHistory)
      .where(and(eq(orderStatusHistory.orderId, id), eq(orderStatusHistory.changedBy, designer.id)))
      .orderBy(desc(orderStatusHistory.createdAt))
      .limit(1);
    const staff = (
      await request(app).get(`/api/v1/reports/staff-activity?q=${encodeURIComponent("Audit Designer")}&limit=10`).set("Authorization", ownerAuth)
    ).body as { staff: { id: string; lastSeenAt: string | null }[] };
    const row = staff.staff.find((s) => s.id === designer.id);
    expect(row?.lastSeenAt).toBe(move!.at.toISOString());
  });
});
