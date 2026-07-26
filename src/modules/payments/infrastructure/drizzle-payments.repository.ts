import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../../common/database/drizzle-client";
// Cross-module Infrastructure-only reads: `orders` is owned by the Orders
// module's schema, `profiles` by the Users module's schema. See
// docs/adr/0003-per-module-schema-ownership.md.
import { orders } from "../../orders/infrastructure/order.schema";
import { profiles } from "../../users/infrastructure/profile.schema";
import { payments } from "./payments.schema";
import { InternalError } from "../../../common/errors/app-error";
import { PaymentsMapper, type PaymentRow } from "./payments.mapper";
import type { PaymentEntity, OrderLedgerContext } from "../domain/payment.entity";
import type { PaymentsRepositoryPort, NewPaymentRecord, UpdatePaymentRecord } from "../application/ports/payments-repository.port";
import type { PaymentMethod } from "../../../domain";

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
    return { designerId: row.designerId, totalAmount: Number(row.totalAmount), paymentStatus: row.paymentStatus };
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

  /** Sums in the database (not in JS after fetching every row) -- scales regardless of how many entries a ledger accumulates. */
  async sumByOrderId(orderId: string): Promise<number> {
    let rows;
    try {
      rows = await db
        .select({ total: sql<string>`coalesce(sum(${payments.amount}), 0)` })
        .from(payments)
        .where(eq(payments.orderId, orderId));
    } catch (error) {
      throw new InternalError("Failed to sum payments", error);
    }
    return Number(rows[0]?.total ?? 0);
  }

  async create(record: NewPaymentRecord): Promise<PaymentEntity> {
    let inserted;
    try {
      [inserted] = await db
        .insert(payments)
        .values({
          orderId: record.orderId,
          amount: String(record.amount),
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

  async update(paymentId: string, data: UpdatePaymentRecord): Promise<PaymentEntity> {
    let existing;
    try {
      [existing] = await db.select({ orderId: payments.orderId }).from(payments).where(eq(payments.id, paymentId)).limit(1);
    } catch (error) {
      throw new InternalError("Failed to update payment", error);
    }
    if (!existing) throw new InternalError("Payment not found");

    const record: Partial<typeof payments.$inferInsert> = {};
    if (data.amount !== undefined) record.amount = String(data.amount);
    if (data.method !== undefined) record.method = data.method as PaymentMethod;
    if (data.paidAt !== undefined) record.paidAt = data.paidAt;
    if (data.notes !== undefined) record.notes = data.notes;

    try {
      await db.update(payments).set(record).where(eq(payments.id, paymentId));
    } catch (error) {
      throw new InternalError("Failed to update payment", error);
    }

    const entity = await this.findById(existing.orderId, paymentId);
    if (!entity) throw new InternalError("Failed to update payment");
    return entity;
  }

  async delete(paymentId: string): Promise<void> {
    try {
      await db.delete(payments).where(eq(payments.id, paymentId));
    } catch (error) {
      throw new InternalError("Failed to delete payment", error);
    }
  }
}
