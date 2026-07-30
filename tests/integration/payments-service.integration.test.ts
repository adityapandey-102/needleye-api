import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PaymentsService } from "../../src/modules/payments/application/payments.service";
import { DrizzlePaymentsRepository } from "../../src/modules/payments/infrastructure/drizzle-payments.repository";
import { DrizzleOrdersRepository } from "../../src/modules/orders/infrastructure/drizzle-orders.repository";
import { createFixtureUser, deleteFixtureOrder, deleteFixtureUser, closeDb } from "./helpers";
import type { FixtureUser } from "./helpers";
import type { Profile } from "../../src/domain";

/**
 * Service <-> Repository integration: PaymentsService wired to the real
 * DrizzlePaymentsRepository/real Postgres, no in-memory fakes -- proves that
 * recording/removing a payment recomputes and syncs the order's DERIVED
 * payment status (unpaid -> advance_paid -> fully_paid) and reschedules the
 * next-payment date, and that the overpayment guard holds end to end against a
 * real sumByOrderId() aggregate, not just the pure-function unit tests.
 */
describe("PaymentsService (integration)", () => {
  const paymentsService = new PaymentsService(new DrizzlePaymentsRepository());
  const ordersRepo = new DrizzleOrdersRepository();
  // Owner scope reads any order unscoped -- used to assert the synced status.
  const unscoped = (userId: string) => ({ role: "owner_manager" as const, userId });

  let designer: FixtureUser;
  let masterTailor: FixtureUser;
  const createdOrderIds: string[] = [];

  beforeAll(async () => {
    designer = await createFixtureUser("designer", "Payments Integration Designer");
    masterTailor = await createFixtureUser("master_tailor", "Payments Integration Master");
  }, 30_000);

  afterAll(async () => {
    for (const id of createdOrderIds) await deleteFixtureOrder(id);
    await deleteFixtureUser(designer.id);
    await deleteFixtureUser(masterTailor.id);
    await closeDb();
  }, 30_000);

  function ctx(): { profile: Profile; authUserId: string; capabilityScope: boolean | "assigned" } {
    return {
      profile: {
        id: designer.id,
        fullName: "Payments Integration Designer",
        email: designer.email,
        role: "designer",
        active: true,
        createdAt: new Date().toISOString(),
      },
      authUserId: designer.id,
      capabilityScope: "assigned",
    };
  }

  it("records an advance and derives advance_paid, scheduling the next payment date", async () => {
    const order = await ordersRepo.create({
      customerName: "Payments Integration Customer",
      phone: "9000000003",
      billNumber: `PAY-${Date.now()}`,
      bookingDate: "2026-01-01",
      dueDate: "2026-02-01",
      nextPaymentDate: null,
      designerId: designer.id,
      masterTailorId: masterTailor.id,
      productCategory: "saree",
      orderDetails: "Advance fixture",
      handWork: false,
      machineWork: true,
      purchaseRequired: false,
      paymentStatus: "unpaid",
      totalAmount: 1000,
      productionStatus: "design_pending",
      designerInstructions: null,
      specialNotes: null,
      createdBy: designer.id,
      updatedBy: designer.id,
    });
    createdOrderIds.push(order.id);

    const payment = await paymentsService.addPayment(ctx(), order.id, {
      amount: 400,
      method: "cash",
      paidAt: "2026-01-05",
      notes: undefined,
      nextPaymentDate: "2026-01-20",
    });
    expect(payment.amount).toBe(400);

    // The order's derived status + schedule were synced from the ledger.
    const synced = await ordersRepo.findById(unscoped(designer.id), order.id);
    expect(synced?.paymentStatus).toBe("advance_paid");
    expect(synced?.nextPaymentDate).toBe("2026-01-20");
  });

  it("derives fully_paid (clearing the next date) then reverts to unpaid when the payment is removed", async () => {
    const order = await ordersRepo.create({
      customerName: "Payments Integration Customer 2",
      phone: "9000000004",
      billNumber: `PAY-${Date.now()}`,
      bookingDate: "2026-01-01",
      dueDate: "2026-02-01",
      nextPaymentDate: "2026-01-15",
      designerId: designer.id,
      masterTailorId: masterTailor.id,
      productCategory: "saree",
      orderDetails: "Fully paid fixture",
      handWork: false,
      machineWork: true,
      purchaseRequired: false,
      paymentStatus: "unpaid",
      totalAmount: 500,
      productionStatus: "design_pending",
      designerInstructions: null,
      specialNotes: null,
      createdBy: designer.id,
      updatedBy: designer.id,
    });
    createdOrderIds.push(order.id);

    // Paying the whole total derives fully_paid and clears the schedule.
    const payment = await paymentsService.addPayment(ctx(), order.id, {
      amount: 500,
      method: "cash",
      paidAt: "2026-01-05",
      notes: undefined,
    });
    const paid = await ordersRepo.findById(unscoped(designer.id), order.id);
    expect(paid?.paymentStatus).toBe("fully_paid");
    expect(paid?.nextPaymentDate).toBeNull();

    // Removing it drops the ledger to 0 -> status re-derives to unpaid.
    await paymentsService.deletePayment(ctx(), order.id, payment.id);
    const reverted = await ordersRepo.findById(unscoped(designer.id), order.id);
    expect(reverted?.paymentStatus).toBe("unpaid");
  });

  it("rejects a payment that would exceed the order total (overpayment), even when not fully_paid", async () => {
    const order = await ordersRepo.create({
      customerName: "Overpay Customer",
      phone: "9000000006",
      billNumber: `PAY-${Date.now()}`,
      bookingDate: "2026-01-01",
      dueDate: "2026-02-01",
      nextPaymentDate: null,
      designerId: designer.id,
      masterTailorId: masterTailor.id,
      productCategory: "saree",
      orderDetails: "Overpayment fixture",
      handWork: false,
      machineWork: true,
      purchaseRequired: false,
      paymentStatus: "unpaid",
      totalAmount: 1000,
      productionStatus: "design_pending",
      designerInstructions: null,
      specialNotes: null,
      createdBy: designer.id,
      updatedBy: designer.id,
    });
    createdOrderIds.push(order.id);

    await paymentsService.addPayment(ctx(), order.id, { amount: 600, method: "cash", paidAt: "2026-01-05", notes: undefined });

    // 600 already recorded against a 1000 total; a further 500 (=1100) overpays.
    await expect(
      paymentsService.addPayment(ctx(), order.id, { amount: 500, method: "cash", paidAt: "2026-01-06", notes: undefined }),
    ).rejects.toMatchObject({ code: "PAYMENT_EXCEEDS_TOTAL" });

    // Exactly the remaining 400 is fine.
    const ok = await paymentsService.addPayment(ctx(), order.id, { amount: 400, method: "cash", paidAt: "2026-01-06", notes: undefined });
    expect(ok.amount).toBe(400);
  });

  it("forbids a designer from managing payments on an order they are not assigned to", async () => {
    const otherDesigner = await createFixtureUser("designer", "Other Payments Designer");
    try {
      const order = await ordersRepo.create({
        customerName: "Not My Order",
        phone: "9000000005",
        billNumber: `PAY-${Date.now()}`,
        bookingDate: "2026-01-01",
        dueDate: "2026-02-01",
        nextPaymentDate: null,
        designerId: otherDesigner.id,
        masterTailorId: masterTailor.id,
        productCategory: "saree",
        orderDetails: "Belongs to someone else",
        handWork: false,
        machineWork: true,
        purchaseRequired: false,
        paymentStatus: "unpaid",
        totalAmount: 1000,
        productionStatus: "design_pending",
        designerInstructions: null,
        specialNotes: null,
        createdBy: otherDesigner.id,
        updatedBy: otherDesigner.id,
      });
      createdOrderIds.push(order.id);

      await expect(
        paymentsService.addPayment(ctx(), order.id, { amount: 100, method: "cash", paidAt: "2026-01-05", notes: undefined }),
      ).rejects.toThrow();
    } finally {
      await deleteFixtureUser(otherDesigner.id);
    }
  });
});
