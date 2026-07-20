import type { GranularStatus, PaymentStatus, ProductCategory } from "../../../domain";

export interface OrderImageDto {
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
export interface OrderDto {
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
  paymentStatus: PaymentStatus;
  totalAmount: number;
  amountPaid: number;
  outstanding: number;
  productionStatus: GranularStatus;
  designerInstructions: string | null;
  specialNotes: string | null;
  images: OrderImageDto[];
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
