import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../../common/database/drizzle-client";
// Cross-module Infrastructure-only reads: `orders` is owned by the Orders
// module's schema, `profiles` by the Users module's schema. See
// docs/adr/0003-per-module-schema-ownership.md.
import { orders } from "../../orders/infrastructure/order.schema";
import { profiles } from "../../users/infrastructure/profile.schema";
import { payments } from "./payments.schema";
import { InternalError, NotFoundError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { BadRequestError } from "../../../common/errors/app-error";
import { addMoney, subtractMoney, toMoneyString } from "../../../common/money/money";
// A repository may depend inward on its own module's domain (Clean Architecture):
// the invariant + status derivation run inside the same locked transaction as the
// write, so they can't be raced. Mirrors OrdersRepository.updateStatus.
import { assertDoesNotExceedTotal, derivePaymentStatus } from "../domain/payment-ledger.rules";
import { PaymentsMapper, type PaymentRow } from "./payments.mapper";
import type { PaymentEntity, OrderLedgerContext } from "../domain/payment.entity";
import type {
  PaymentsRepositoryPort,
  NewPaymentRecord,
  UpdatePaymentRecord,
} from "../application/ports/payments-repository.port";
import type { PaymentMethod } from "../../../domain";

/** The transactional client Drizzle hands the `db.transaction` callback. */
type TxLike = Parameters<Parameters<typeof db.transaction>[0]>[0];

const PAYMENT_ROW_SELECT = {
  id: payments.id,
  orderId: payments.orderId,
  amount: payments.amount,
  method: payments.method,
  paidAt: payments.paidAt,
  recordedBy: payments.recordedBy,
  notes: payments.notes,
  createdAt: payments.createdAt,
  recorderFullName: profiles.fullName,
};

/**
 * Concrete adapter satisfying PaymentsRepositoryPort. Reads `orders` (owned
 * by the Orders module's schema) and `profiles` (owned by the Users
 * module's schema) for the minimal read-only context it needs
 * (designerId/totalAmount/paymentStatus, and a recorder's name).
 * Infrastructure-to-Infrastructure only -- this never imports Orders' or
 * Users' Application/Domain layers (see docs/adr/0003-per-module-schema-ownership.md).
 */
export class DrizzlePaymentsRepository implements PaymentsRepositoryPort {
  private readonly mapper = new PaymentsMapper();

  async findOrderContext(orderId: string): Promise<OrderLedgerContext | null> {
    let rows;
    try {
      rows = await db
        .select({ designerId: orders.designerId, totalAmount: orders.totalAmount, paymentStatus: orders.paymentStatus })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
    } catch (error) {
      throw new InternalError("Failed to load order", error);
    }
    const row = rows[0];
    if (!row) return null;
    return { designerId: row.designerId, totalAmount: toMoneyString(row.totalAmount), paymentStatus: row.paymentStatus };
  }

  async findByOrderId(orderId: string): Promise<PaymentEntity[]> {
    let rows: PaymentRow[];
    try {
      rows = await db
        .select(PAYMENT_ROW_SELECT)
        .from(payments)
        .leftJoin(profiles, eq(profiles.id, payments.recordedBy))
        .where(eq(payments.orderId, orderId))
        .orderBy(desc(payments.paidAt));
    } catch (error) {
      throw new InternalError("Failed to load payments", error);
    }
    return rows.map((row) => this.mapper.toEntity(row));
  }

  async findById(orderId: string, paymentId: string): Promise<PaymentEntity | null> {
    let rows: PaymentRow[];
    try {
      rows = await db
        .select(PAYMENT_ROW_SELECT)
        .from(payments)
        .leftJoin(profiles, eq(profiles.id, payments.recordedBy))
        .where(and(eq(payments.orderId, orderId), eq(payments.id, paymentId)))
        .limit(1);
    } catch (error) {
      throw new InternalError("Failed to load payment", error);
    }
    const row = rows[0];
    return row ? this.mapper.toEntity(row) : null;
  }

  /** Ledger sum for an order, computed in the DB. Locks nothing -- callers that
   *  need the invariant re-read this inside the locked transaction below. */
  private async sumInTx(tx: TxLike, orderId: string): Promise<string> {
    const rows = await tx
      .select({ total: sql<string>`coalesce(sum(${payments.amount}), 0)` })
      .from(payments)
      .where(eq(payments.orderId, orderId));
    return toMoneyString(rows[0]?.total ?? 0);
  }

  /** Locks the order row for the rest of the transaction and returns its total. */
  private async lockOrderTotal(tx: TxLike, orderId: string): Promise<string> {
    const rows = await tx.select({ total: orders.totalAmount }).from(orders).where(eq(orders.id, orderId)).for("update");
    const total = rows[0]?.total;
    if (total === undefined) throw new NotFoundError("Order not found", ERROR_CODES.ORDER_NOT_FOUND);
    return toMoneyString(total);
  }

  async create(record: NewPaymentRecord): Promise<PaymentEntity> {
    let inserted;
    try {
      [inserted] = await db
        .insert(payments)
        .values({
          orderId: record.orderId,
          amount: toMoneyString(record.amount),
          method: record.method as PaymentMethod,
          paidAt: record.paidAt,
          recordedBy: record.recordedBy,
          notes: record.notes,
        })
        .returning({ id: payments.id });
    } catch (error) {
      throw new InternalError("Failed to record payment", error);
    }
    if (!inserted) throw new InternalError("Failed to record payment");

    const entity = await this.findById(record.orderId, inserted.id);
    if (!entity) throw new InternalError("Failed to record payment");
    return entity;
  }

  async recordPayment(record: NewPaymentRecord, nextPaymentDate: string | null | undefined): Promise<PaymentEntity> {
    let insertedId: string;
    try {
      insertedId = await db.transaction(async (tx) => {
        // Lock the order first: two staff recording a payment on the SAME order
        // now serialize here, so the overpayment check + insert below can't be
        // raced into an overpaid ledger.
        const total = await this.lockOrderTotal(tx, record.orderId);
        const newSum = addMoney(await this.sumInTx(tx, record.orderId), record.amount);
        assertDoesNotExceedTotal(newSum, total); // 400 PAYMENT_EXCEEDS_TOTAL

        const [inserted] = await tx
          .insert(payments)
          .values({
            orderId: record.orderId,
            amount: toMoneyString(record.amount),
            method: record.method as PaymentMethod,
            paidAt: record.paidAt,
            recordedBy: record.recordedBy,
            notes: record.notes,
          })
          .returning({ id: payments.id });
        if (!inserted) throw new InternalError("Failed to record payment");

        // Recompute the derived order state from the new ledger total: clear the
        // schedule once fully paid, otherwise reschedule to the supplied date
        // (undefined leaves it untouched -- Drizzle omits undefined from SET).
        const status = derivePaymentStatus(newSum, total);
        await tx
          .update(orders)
          .set({ paymentStatus: status, nextPaymentDate: status === "fully_paid" ? null : nextPaymentDate })
          .where(eq(orders.id, record.orderId));

        return inserted.id;
      });
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof BadRequestError) throw error;
      throw new InternalError("Failed to record payment", error);
    }

    const entity = await this.findById(record.orderId, insertedId);
    if (!entity) throw new InternalError("Failed to record payment");
    return entity;
  }

  async editPayment(orderId: string, paymentId: string, data: UpdatePaymentRecord): Promise<PaymentEntity | null> {
    let found: boolean;
    try {
      found = await db.transaction(async (tx) => {
        const total = await this.lockOrderTotal(tx, orderId);
        const existing = (
          await tx
            .select({ amount: payments.amount })
            .from(payments)
            .where(and(eq(payments.id, paymentId), eq(payments.orderId, orderId)))
            .limit(1)
        )[0];
        if (!existing) return false;

        const patch: Partial<typeof payments.$inferInsert> = {};
        if (data.amount !== undefined) patch.amount = toMoneyString(data.amount);
        if (data.method !== undefined) patch.method = data.method as PaymentMethod;
        if (data.paidAt !== undefined) patch.paidAt = data.paidAt;
        if (data.notes !== undefined) patch.notes = data.notes;

        if (data.amount !== undefined) {
          // Swap this entry's contribution for the new amount and re-check.
          const newSum = addMoney(subtractMoney(await this.sumInTx(tx, orderId), existing.amount), data.amount);
          assertDoesNotExceedTotal(newSum, total, "update");
          await tx.update(payments).set(patch).where(eq(payments.id, paymentId));
          // Editing the amount changes the derived status; the schedule is left
          // as-is (rescheduling only happens when recording a new payment).
          await tx.update(orders).set({ paymentStatus: derivePaymentStatus(newSum, total) }).where(eq(orders.id, orderId));
        } else {
          await tx.update(payments).set(patch).where(eq(payments.id, paymentId));
        }
        return true;
      });
    } catch (error) {
      if (error instanceof NotFoundError || error instanceof BadRequestError) throw error;
      throw new InternalError("Failed to update payment", error);
    }

    if (!found) return null;
    const entity = await this.findById(orderId, paymentId);
    if (!entity) throw new InternalError("Failed to update payment");
    return entity;
  }

  async removePayment(orderId: string, paymentId: string): Promise<boolean> {
    try {
      return await db.transaction(async (tx) => {
        const total = await this.lockOrderTotal(tx, orderId);
        const existing = (
          await tx
            .select({ id: payments.id })
            .from(payments)
            .where(and(eq(payments.id, paymentId), eq(payments.orderId, orderId)))
            .limit(1)
        )[0];
        if (!existing) return false;

        await tx.delete(payments).where(eq(payments.id, paymentId));
        // Reduced ledger -> re-derive status (schedule left untouched).
        const newSum = await this.sumInTx(tx, orderId);
        await tx.update(orders).set({ paymentStatus: derivePaymentStatus(newSum, total) }).where(eq(orders.id, orderId));
        return true;
      });
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      throw new InternalError("Failed to delete payment", error);
    }
  }
}
