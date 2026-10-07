import type { GranularStatus, PaymentStatus, ProductCategory } from "../../../../domain";

export interface OrderImageResponseDto {
  id: string;
  orderId: string;
  slot: number;
  storagePath: string;
  url: string;
  originalFilename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  uploadedBy: string | null;
  createdAt: string;
}

/** Response shape returned to the client. */
export interface OrderResponseDto {
  id: string;
  orderNumber: string;
  customerName: string;
  phone: string;
  billNumber: string;
  bookingDate: string;
  dueDate: string;
  nextPaymentDate: string | null;
  designerId: string;
  designerName?: string;
  masterTailorId: string;
  masterTailorName?: string;
  productCategory: ProductCategory;
  orderDetails: string;
  handWork: boolean;
  machineWork: boolean;
  purchaseRequired: boolean;
  /**
   * Present only when the caller's role has `payments:read` (owner_manager,
   * accountant, or designer viewing their own order). Stripped server-side
   * for master_tailor -- see domain/order-visibility.rules.ts -- so this is
   * a real access control, not just a UI convenience.
   */
  paymentStatus?: PaymentStatus;
  // Money as 2dp strings (see common/money/money.ts). totalAmount and
  // outstanding are null while the order has no price (ADR 0008).
  totalAmount?: string | null;
  amountPaid?: string;
  outstanding?: string | null;
  /** Whether the order has a price -- visible to EVERY role (it's not an amount), so any role can tell Delivered needs pricing first. */
  priceSet: boolean;
  productionStatus: GranularStatus;
  designerInstructions: string | null;
  specialNotes: string | null;
  version: number;
  images: OrderImageResponseDto[];
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * One row of GET /orders: an order WITHOUT `images`. No list screen shows
 * photos, and each photo would need a signed URL from storage, so lists skip
 * them. GET /orders/:id returns the full order with signed image URLs.
 */
export type OrderListItemResponseDto = Omit<OrderResponseDto, "images">;
