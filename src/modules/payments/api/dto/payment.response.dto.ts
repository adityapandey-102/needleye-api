import type { PaymentMethod } from "../../../../domain";

/** Response shape returned to the client -- the API's contract, kept explicit and separate from the domain entity even though they currently match field-for-field (see payment.presenter.ts). */
export interface PaymentResponseDto {
  id: string;
  orderId: string;
  /** Money as a 2dp string. */
  amount: string;
  method: PaymentMethod;
  paidAt: string;
  recordedBy: string | null;
  recordedByName?: string;
  notes: string | null;
  createdAt: string;
}
