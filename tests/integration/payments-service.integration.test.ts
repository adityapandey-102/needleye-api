import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PaymentsService } from "../../src/modules/payments/application/payments.service";
import { DrizzlePaymentsRepository } from "../../src/modules/payments/infrastructure/drizzle-payments.repository";
import { DrizzleOrdersRepository } from "../../src/modules/orders/infrastructure/drizzle-orders.repository";
import { ConflictError } from "../../src/common/errors/app-error";
import { createFixtureUser, deleteFixtureOrder, deleteFixtureUser, closeDb } from "./helpers";
import type { FixtureUser } from "./helpers";
import type { Profile } from "../../src/domain";

/**
 * Service <-> Repository integration: PaymentsService wired to the real
 * DrizzlePaymentsRepository/real Postgres, no in-memory fakes -- proves
 * the fully-paid ledger-reconciliation invariant (assertLedgerReconciles)
 * actually holds end to end, against a real sumByOrderId() aggregate query,
 * not just the pure-function unit test in payment-ledger.rules.test.ts.
 */
describe("PaymentsService (integration)", () => {
  const paymentsService = new PaymentsService(new DrizzlePaymentsRepository());
  const ordersRepo = new DrizzleOrdersRepository();

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

  it("allows recording a payment on a partially-paid order with no reconciliation check", async () => {
    const order = await ordersRepo.create({
      customerName: "Payments Integration Customer",
      phone: "9000000003",
      billNumber: `PAY-${Date.now()}`,
      bookingDate: "2026-01-01",
      dueDate: "2026-02-01",
      designerId: designer.id,
      masterTailorId: masterTailor.id,
      productCategory: "saree",
      orderDetails: "Partially paid fixture",
      handWork: false,
      machineWork: true,
      purchaseRequired: false,
      paymentStatus: "partially_paid",
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
    });
    expect(payment.amount).toBe(400);
  });

  it("rejects a payment on a fully-paid order that would break ledger reconciliation", async () => {
    const order = await ordersRepo.create({
      customerName: "Payments Integration Customer 2",
      phone: "9000000004",
      billNumber: `PAY-${Date.now()}`,
      bookingDate: "2026-01-01",
      dueDate: "2026-02-01",
      designerId: designer.id,
      masterTailorId: masterTailor.id,
      productCategory: "saree",
      orderDetails: "Fully paid fixture",
      handWork: false,
      machineWork: true,
      purchaseRequired: false,
      paymentStatus: "fully_paid",
      totalAmount: 500,
      productionStatus: "design_pending",
      designerInstructions: null,
      specialNotes: null,
      createdBy: designer.id,
      updatedBy: designer.id,
    });
    createdOrderIds.push(order.id);

    // Already reconciled at 500; recording another 100 would make the
    // ledger sum (600) disagree with total_amount (500) on a fully_paid order.
    await paymentsService.addPayment(ctx(), order.id, { amount: 500, method: "cash", paidAt: "2026-01-05", notes: undefined });

    await expect(
      paymentsService.addPayment(ctx(), order.id, { amount: 100, method: "cash", paidAt: "2026-01-06", notes: undefined }),
    ).rejects.toThrow(ConflictError);
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
        designerId: otherDesigner.id,
        masterTailorId: masterTailor.id,
        productCategory: "saree",
        orderDetails: "Belongs to someone else",
        handWork: false,
        machineWork: true,
        purchaseRequired: false,
        paymentStatus: "partially_paid",
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
