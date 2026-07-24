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
}
