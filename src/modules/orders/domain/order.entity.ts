import type { GranularStatus, PaymentStatus, ProductCategory } from "../../../domain";

export interface OrderImageEntity {
  id: string;
  orderId: string;
  slot: number;
  storagePath: string;
  originalFilename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  uploadedBy: string | null;
  createdAt: string;
}

/**
 * The in-memory domain representation of an Order -- distinct from both
 * the raw Drizzle query result (infrastructure/order.mapper.ts) and the
 * camelCase wire shape with resolved signed image URLs
 * (api/dto/order.response.dto.ts). The repository maps rows into this; the
 * service operates on this; the presenter turns this into a DTO only at the
 * point a response actually needs to be sent (resolving image URLs is an
 * async, I/O-bound step that doesn't belong on a plain domain object).
 */
export interface OrderEntity {
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
  productionStatus: GranularStatus;
  designerInstructions: string | null;
  specialNotes: string | null;
  version: number;
  images: OrderImageEntity[];
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
