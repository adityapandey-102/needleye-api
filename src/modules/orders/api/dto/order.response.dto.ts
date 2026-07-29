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
  totalAmount?: number;
  amountPaid?: number;
  outstanding?: number;
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
