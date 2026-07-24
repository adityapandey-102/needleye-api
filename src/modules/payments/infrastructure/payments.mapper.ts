import type { PaymentEntity } from "../domain/payment.entity";
import type { PaymentMethod } from "../../../domain";

/**
 * Raw Drizzle query result shape -- infrastructure-only, never leaves this
 * layer. Distinct from PaymentEntity (domain) and PaymentResponseDto (API):
 * this one is allowed to carry vendor/ORM-shaped quirks (e.g. createdAt as
 * a real Date object, not yet stringified).
 */
export type PaymentRow = {
  id: string;
  orderId: string;
  amount: string;
  method: string;
  paidAt: string;
  recordedBy: string | null;
  notes: string | null;
  createdAt: Date;
  recorderFullName: string | null;
};

export class PaymentsMapper {
  toEntity(row: PaymentRow): PaymentEntity {
    return {
      id: row.id,
      orderId: row.orderId,
      amount: Number(row.amount),
      method: row.method as PaymentMethod,
      paidAt: row.paidAt,
      recordedBy: row.recordedBy,
      recordedByName: row.recorderFullName ?? undefined,
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
