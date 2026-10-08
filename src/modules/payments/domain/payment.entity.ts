import type { PaymentMethod } from "../../../domain";

/**
 * Pure domain entity -- no persistence shape, no HTTP shape, no framework
 * concerns. This is what the Application layer and business rules operate
 * on; Infrastructure maps Drizzle rows into this, the API layer maps this
 * into the response DTO.
 */
export interface PaymentEntity {
  id: string;
  orderId: string;
  /** Money as a canonical 2dp string (see common/money/money.ts). */
  amount: string;
  method: PaymentMethod;
  paidAt: string;
  recordedBy: string | null;
  recordedByName?: string;
  notes: string | null;
  createdAt: string;
  /** Dated in a month whose books are closed: it can't be edited or removed (ADR 0008 phase 5). */
  monthClosed: boolean;
}

/**
 * The order fields the ledger's business rules need -- not the full Order
 * aggregate (which belongs to the Orders module). Kept intentionally
 * minimal: this is the *contract* Payments needs from an order, not a
 * reference to Orders' domain model.
 */
export interface OrderLedgerContext {
  designerId: string;
  /** Money as a canonical 2dp string (see common/money/money.ts); null = the order has no price yet. */
  totalAmount: string | null;
  paymentStatus: string;
  productionStatus: string;
}
