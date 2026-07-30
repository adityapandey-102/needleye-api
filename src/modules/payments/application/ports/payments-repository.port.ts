import type { PaymentEntity, OrderLedgerContext } from "../../domain/payment.entity";

export interface NewPaymentRecord {
  orderId: string;
  amount: number;
  method: string;
  paidAt: string;
  recordedBy: string;
  notes: string | null;
}

export interface UpdatePaymentRecord {
  amount?: number;
  method?: string;
  paidAt?: string;
  notes?: string | null;
}

/**
 * The derived order-level state a ledger change writes back to the order:
 * the recomputed payment status, and (optionally) the rescheduled next-payment
 * date. `nextPaymentDate` is only applied when present -- `undefined` leaves
 * the existing schedule untouched; `null` clears it (e.g. once fully paid).
 */
export interface OrderLedgerStateUpdate {
  paymentStatus: string;
  nextPaymentDate?: string | null;
}

/**
 * What the Application layer needs from persistence, expressed in domain
 * terms -- PaymentsService depends on this port only, never on the
 * concrete Drizzle adapter that satisfies it
 * (infrastructure/drizzle-payments.repository.ts). Swapping the persistence
 * technology, adding a cached/read-replica/test-double implementation, all
 * mean writing a new class against this same interface -- nothing above
 * this line changes.
 */
export interface PaymentsRepositoryPort {
  findOrderContext(orderId: string): Promise<OrderLedgerContext | null>;
  findByOrderId(orderId: string): Promise<PaymentEntity[]>;
  findById(orderId: string, paymentId: string): Promise<PaymentEntity | null>;
  sumByOrderId(orderId: string): Promise<number>;
  create(record: NewPaymentRecord): Promise<PaymentEntity>;
  update(paymentId: string, data: UpdatePaymentRecord): Promise<PaymentEntity>;
  delete(paymentId: string): Promise<void>;
  /**
   * Writes the derived payment status (and optional rescheduled next-payment
   * date) back onto the order after a ledger change. A cross-module
   * Infrastructure-to-Infrastructure write into the Orders-owned `orders`
   * table -- the same table this repo already reads via findOrderContext (see
   * docs/adr/0003-per-module-schema-ownership.md).
   */
  updateOrderLedgerState(orderId: string, update: OrderLedgerStateUpdate): Promise<void>;
}
