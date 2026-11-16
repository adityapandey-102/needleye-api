import type { GranularStatus, PaymentStatus } from "../../../../domain";

/** One order in the overdue-orders export -- the columns the owner asked for. Money as 2dp strings, dates YYYY-MM-DD. */
export interface OverdueExportOrderDto {
  id: string;
  orderNumber: string;
  customerName: string;
  phone: string;
  designerName: string | null;
  productionStatus: GranularStatus;
  paymentStatus: PaymentStatus;
  bookingDate: string;
  dueDate: string;
  /** Null while the order has no price yet (payment status not_priced). */
  totalAmount: string | null;
  amountPaid: string;
  /** Null while the order has no price yet. */
  outstanding: string | null;
  /** The newest payment's date; null when nothing has been paid yet. */
  lastPaymentDate: string | null;
  /** The expected next payment, when one was scheduled. */
  nextPaymentDate: string | null;
}

/** GET /orders/overdue/export: every order past its due date and not delivered, at once, unpaged, most overdue first. */
export interface OverdueExportResponseDto {
  orders: OverdueExportOrderDto[];
  total: number;
  /** The shop's day the list was taken on (YYYY-MM-DD). */
  asOf: string;
  timeZone: string;
}
