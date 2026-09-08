import type { PaymentEntity, OrderLedgerContext } from "../../domain/payment.entity";

export interface NewPaymentRecord {
  orderId: string;
  /** Money as a 2dp string. */
  amount: string;
  method: string;
  paidAt: string;
  recordedBy: string;
  notes: string | null;
}

export interface UpdatePaymentRecord {
  /** Money as a 2dp string. */
  amount?: string;
  method?: string;
  paidAt?: string;
  notes?: string | null;
}

/**
 * What the Application layer needs from persistence, expressed in domain
 * terms -- PaymentsService depends on this port only, never on the
 * concrete Drizzle adapter that satisfies it
 * (infrastructure/drizzle-payments.repository.ts). Swapping the persistence
 * technology, adding a cached/read-replica/test-double implementation, all
 * mean writing a new class against this same interface -- nothing above
 * this line changes.
 *
 * The three ledger MUTATIONS (`recordPayment`/`editPayment`/`removePayment`)
 * are each atomic and concurrency-safe: they run in one transaction that first
 * locks the order row (`SELECT ... FOR UPDATE`), then re-reads the ledger sum,
 * enforces the no-overpayment invariant, writes the payment, and recomputes the
 * order's derived payment_status -- so two staff recording payments on the same
 * order at once serialize instead of both passing a stale overpayment check.
 * This mirrors OrdersRepository.updateStatus (see ADR 0005).
 */
export interface PaymentsRepositoryPort {
  findOrderContext(orderId: string): Promise<OrderLedgerContext | null>;
  findByOrderId(orderId: string): Promise<PaymentEntity[]>;
  findById(orderId: string, paymentId: string): Promise<PaymentEntity | null>;
  /**
   * Plain insert with no guard -- used only by the dev seed, which generates
   * controlled, within-total data single-threaded. The guarded, order-state-
   * syncing path is `recordPayment`.
   */
  create(record: NewPaymentRecord): Promise<PaymentEntity>;
  /**
   * Records a payment atomically under an order row lock: rejects overpayment
   * with `409 PAYMENT_EXCEEDS_TOTAL`, then recomputes payment_status and (when a
   * balance remains and `nextPaymentDate` is supplied) reschedules the next
   * payment date -- cleared once fully paid.
   */
  recordPayment(record: NewPaymentRecord, nextPaymentDate: string | null | undefined): Promise<PaymentEntity>;
  /**
   * Edits a payment atomically under an order row lock. When `amount` changes,
   * re-checks the overpayment invariant against the rest of the ledger and
   * recomputes payment_status (the next-payment schedule is left untouched).
   * Returns null if the payment doesn't exist on that order.
   */
  editPayment(orderId: string, paymentId: string, data: UpdatePaymentRecord): Promise<PaymentEntity | null>;
  /**
   * Removes a payment atomically under an order row lock and recomputes the
   * order's payment_status from the reduced ledger. Returns false if the
   * payment doesn't exist on that order.
   */
  removePayment(orderId: string, paymentId: string): Promise<boolean>;
}
