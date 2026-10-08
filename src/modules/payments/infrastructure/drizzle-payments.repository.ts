import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../../../common/database/drizzle-client";
// Cross-module Infrastructure-only reads: `orders` is owned by the Orders
// module's schema, `profiles` by the Users module's schema. See
// docs/adr/0003-per-module-schema-ownership.md.
import { orders } from "../../orders/infrastructure/order.schema";
import { profiles } from "../../users/infrastructure/profile.schema";
import { payments } from "./payments.schema";
import { paymentAuditLog, type PaymentAuditAction } from "./payment-audit-log.schema";
import { getRequestContext } from "../../../common/context/request-context";
import { LEDGER_MONTH_LOCK_NAMESPACE } from "../../../common/database/ledger-month-lock";
import { AppError, InternalError, NotFoundError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { addMoney, subtractMoney, toMoneyString } from "../../../common/money/money";
// A repository may depend inward on its own module's domain (Clean Architecture):
// the invariant + status derivation run inside the same locked transaction as the
// write, so they can't be raced. Mirrors OrdersRepository.updateStatus.
import {
  assertDoesNotExceedTotal,
  assertMonthOpen,
  assertOrderPriced,
  derivePaymentStatus,
  paymentMonths,
} from "../domain/payment-ledger.rules";
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

/** A payment's loggable values. Money as a 2dp string, date as YYYY-MM-DD. */
interface PaymentValues {
  amount: string;
  method: string;
  paidAt: string;
  notes: string | null;
}

/**
 * Appends one payment_audit_log row inside the caller's transaction (ADR 0008):
 * the payment's values after the action (or as removed), and for an edit the
 * values before it. The request id ties it to the application log.
 */
async function logPayment(
  tx: TxLike,
  entry: { paymentId: string; orderId: string; action: PaymentAuditAction; actorId: string; now: PaymentValues; before?: PaymentValues },
): Promise<void> {
  await tx.insert(paymentAuditLog).values({
    paymentId: entry.paymentId,
    orderId: entry.orderId,
    action: entry.action,
    amount: toMoneyString(entry.now.amount),
    method: entry.now.method,
    paidAt: entry.now.paidAt,
    notes: entry.now.notes,
    previousAmount: entry.before ? toMoneyString(entry.before.amount) : null,
    previousMethod: entry.before?.method ?? null,
    previousPaidAt: entry.before?.paidAt ?? null,
    previousNotes: entry.before?.notes ?? null,
    actorId: entry.actorId,
    requestId: getRequestContext()?.requestId ?? null,
  });
}

/** The full row an edit or removal logs as "before" -- read under the order lock. */
async function loadPaymentValues(tx: TxLike, orderId: string, paymentId: string): Promise<PaymentValues | null> {
  const [row] = await tx
    .select({ amount: payments.amount, method: payments.method, paidAt: payments.paidAt, notes: payments.notes })
    .from(payments)
    .where(and(eq(payments.id, paymentId), eq(payments.orderId, orderId)))
    .limit(1);
  return row ? { amount: toMoneyString(row.amount), method: row.method, paidAt: row.paidAt, notes: row.notes } : null;
}

/**
 * Refuses the change if any month it touches is closed (ADR 0008 phase 5) --
 * checked under that month's SHARED lock, in month order; closing a month takes
 * it exclusively. The database guard (payments_closed_month_guard) takes the
 * same lock and re-checks -- a backstop for writes that don't come through here.
 */
async function assertMonthsOpen(tx: TxLike, ...days: (string | null | undefined)[]): Promise<void> {
  for (const month of paymentMonths(...days)) {
    const day = `${month}-01`;
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${LEDGER_MONTH_LOCK_NAMESPACE}::int, public.ledger_month_key(${day}::date))`);
    // A separate statement, so it sees a close that committed while we waited for the lock.
    const res = await tx.execute<{ closed: boolean }>(sql`select public.ledger_month_closed(${day}::date) as closed`);
    assertMonthOpen(month, res.rows[0]?.closed === true);
  }
}

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
  // One index lookup per payment of one order -- the same definition of
  // "closed" the database guard uses.
  monthClosed: sql<boolean>`public.ledger_month_closed(${payments.paidAt})`,
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
        .select({
          designerId: orders.designerId,
          totalAmount: orders.totalAmount,
          paymentStatus: orders.paymentStatus,
          productionStatus: orders.productionStatus,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
    } catch (error) {
      throw new InternalError("Failed to load order", error);
    }
    const row = rows[0];
    if (!row) return null;
    return {
      designerId: row.designerId,
      totalAmount: row.totalAmount === null ? null : toMoneyString(row.totalAmount),
      paymentStatus: row.paymentStatus,
      productionStatus: row.productionStatus,
    };
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

  /** Locks the order row for the rest of the transaction and returns its total (null = not priced) and stage. */
  private async lockOrder(tx: TxLike, orderId: string): Promise<{ total: string | null; productionStatus: string }> {
    const rows = await tx
      .select({ total: orders.totalAmount, productionStatus: orders.productionStatus })
      .from(orders)
      .where(eq(orders.id, orderId))
      .for("update");
    const row = rows[0];
    if (!row) throw new NotFoundError("Order not found", ERROR_CODES.ORDER_NOT_FOUND);
    return { total: row.total === null ? null : toMoneyString(row.total), productionStatus: row.productionStatus };
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
        const { total } = await this.lockOrder(tx, record.orderId);
        assertOrderPriced(total); // 409 PAYMENT_ORDER_NOT_PRICED -- price first (ADR 0008)
        await assertMonthsOpen(tx, record.paidAt); // 409 PAYMENT_MONTH_CLOSED (phase 5)
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
        await logPayment(tx, {
          paymentId: inserted.id,
          orderId: record.orderId,
          action: "created",
          actorId: record.recordedBy,
          now: { amount: toMoneyString(record.amount), method: record.method, paidAt: record.paidAt, notes: record.notes },
        });

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
      if (error instanceof AppError) throw error;
      throw new InternalError("Failed to record payment", error);
    }

    const entity = await this.findById(record.orderId, insertedId);
    if (!entity) throw new InternalError("Failed to record payment");
    return entity;
  }

  async editPayment(orderId: string, paymentId: string, data: UpdatePaymentRecord, actorId: string): Promise<PaymentEntity | null> {
    let found: boolean;
    try {
      found = await db.transaction(async (tx) => {
        // Delivery doesn't lock payments (owner, 2026-10-09) -- closed months do.
        const { total } = await this.lockOrder(tx, orderId);
        assertOrderPriced(total); // a recorded payment implies a price; belt and braces
        const existing = await loadPaymentValues(tx, orderId, paymentId);
        if (!existing) return false;
        await assertMonthsOpen(tx, existing.paidAt, data.paidAt); // neither the old nor the new month may be closed

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

        // Log the edit with both sides -- only when something actually changed.
        const now: PaymentValues = {
          amount: data.amount !== undefined ? toMoneyString(data.amount) : existing.amount,
          method: data.method ?? existing.method,
          paidAt: data.paidAt ?? existing.paidAt,
          notes: data.notes !== undefined ? data.notes : existing.notes,
        };
        const changed =
          now.amount !== existing.amount || now.method !== existing.method || now.paidAt !== existing.paidAt || now.notes !== existing.notes;
        if (changed) await logPayment(tx, { paymentId, orderId, action: "updated", actorId, now, before: existing });
        return true;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new InternalError("Failed to update payment", error);
    }

    if (!found) return null;
    const entity = await this.findById(orderId, paymentId);
    if (!entity) throw new InternalError("Failed to update payment");
    return entity;
  }

  async removePayment(orderId: string, paymentId: string, actorId: string): Promise<boolean> {
    try {
      return await db.transaction(async (tx) => {
        const { total } = await this.lockOrder(tx, orderId);
        const existing = await loadPaymentValues(tx, orderId, paymentId);
        if (!existing) return false;
        await assertMonthsOpen(tx, existing.paidAt);

        await tx.delete(payments).where(eq(payments.id, paymentId));
        // The removed payment's values are kept in the log (the row itself is gone).
        await logPayment(tx, { paymentId, orderId, action: "deleted", actorId, now: existing });
        // Reduced ledger -> re-derive status (schedule left untouched).
        const newSum = await this.sumInTx(tx, orderId);
        await tx.update(orders).set({ paymentStatus: derivePaymentStatus(newSum, total) }).where(eq(orders.id, orderId));
        return true;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new InternalError("Failed to delete payment", error);
    }
  }
}
