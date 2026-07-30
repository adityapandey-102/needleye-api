import type { OrderEntity } from "../domain/order.entity";

/** Shape returned by db.query.orders.find{Many,First} with the `with` config used in drizzle-orders.repository.ts. */
export type OrderQueryResult = {
  id: string;
  orderNumber: string;
  customerName: string;
  phone: string;
  billNumber: string;
  bookingDate: string;
  dueDate: string;
  nextPaymentDate: string | null;
  designerId: string;
  masterTailorId: string;
  productCategory: OrderEntity["productCategory"];
  orderDetails: string;
  handWork: boolean;
  machineWork: boolean;
  purchaseRequired: boolean;
  paymentStatus: OrderEntity["paymentStatus"];
  totalAmount: string;
  productionStatus: OrderEntity["productionStatus"];
  version: number;
  designerInstructions: string | null;
  specialNotes: string | null;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
  designer: { fullName: string } | null;
  masterTailor: { fullName: string } | null;
  images: Array<{
    id: string;
    slot: number;
    storagePath: string;
    originalFilename: string | null;
    contentType: string | null;
    sizeBytes: number | null;
    uploadedBy: string | null;
    createdAt: Date;
  }>;
};

export const OrderMapper = {
  toEntity(row: OrderQueryResult): OrderEntity {
    return {
      id: row.id,
      orderNumber: row.orderNumber,
      customerName: row.customerName,
      phone: row.phone,
      billNumber: row.billNumber,
      bookingDate: row.bookingDate,
      dueDate: row.dueDate,
      nextPaymentDate: row.nextPaymentDate,
      designerId: row.designerId,
      designerName: row.designer?.fullName,
      masterTailorId: row.masterTailorId,
      masterTailorName: row.masterTailor?.fullName,
      productCategory: row.productCategory,
      orderDetails: row.orderDetails,
      handWork: row.handWork,
      machineWork: row.machineWork,
      purchaseRequired: row.purchaseRequired,
      paymentStatus: row.paymentStatus,
      totalAmount: Number(row.totalAmount),
      productionStatus: row.productionStatus,
      designerInstructions: row.designerInstructions,
      specialNotes: row.specialNotes,
      version: row.version,
      images: row.images
        .sort((a, b) => a.slot - b.slot)
        .map((img) => ({
          id: img.id,
          orderId: row.id,
          slot: img.slot,
          storagePath: img.storagePath,
          originalFilename: img.originalFilename,
          contentType: img.contentType,
          sizeBytes: img.sizeBytes,
          uploadedBy: img.uploadedBy,
          createdAt: img.createdAt.toISOString(),
        })),
      createdBy: row.createdBy,
      updatedBy: row.updatedBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  },
};
