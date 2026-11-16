import type { GranularStatus, PaymentStatus } from "../../../../domain";

/** One order in the payment-overdue export -- the columns the owner asked for. Money as 2dp strings, dates YYYY-MM-DD. */
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
  totalAmount: string;
  amountPaid: string;
  outstanding: string;
  /** The newest payment's date; null when nothing has been paid yet. */
  lastPaymentDate: string | null;
  /** The scheduled next payment -- always set here, and before today (that's what makes it overdue). */
  nextPaymentDate: string;
}

/** GET /orders/payment-overdue/export: every overdue order at once, unpaged, oldest payment date first. */
export interface OverdueExportResponseDto {
  orders: OverdueExportOrderDto[];
  total: number;
  /** The shop's day the list was taken on (YYYY-MM-DD) -- "overdue" means a next payment date before it. */
  asOf: string;
  timeZone: string;
}
