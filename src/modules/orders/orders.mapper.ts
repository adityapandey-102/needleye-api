import type { StorageProvider } from "../../common/storage/storage-provider";
import type { NewOrderRecord, OrderRow } from "./orders.repository";
import type { OrderEntity } from "./orders.entity";
import type { CreateOrderDto } from "./dto/create-order.dto";
import type { OrderDto } from "./dto/order.dto";

function toOne<T>(value: T[] | T | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

/** DTO field name -> repository (DB column) name, for the writable Order fields. */
const FIELD_TO_COLUMN: Record<string, string> = {
  customerName: "customer_name",
  phone: "phone",
  billNumber: "bill_number",
  bookingDate: "booking_date",
  dueDate: "due_date",
  designerId: "designer_id",
  masterTailorId: "master_tailor_id",
  productCategory: "product_category",
  orderDetails: "order_details",
  handWork: "hand_work",
  machineWork: "machine_work",
  purchaseRequired: "purchase_required",
  paymentStatus: "payment_status",
  totalAmount: "total_amount",
  designerInstructions: "designer_instructions",
  specialNotes: "special_notes",
};

export class OrdersMapper {
  constructor(private readonly storageProvider: StorageProvider) {}

  /** Persistence row (snake_case, FK-embedded) -> domain entity. Pure, synchronous. */
  toEntity(row: OrderRow): OrderEntity {
    const designer = toOne(row.designer);
    const masterTailor = toOne(row.master_tailor);

    return {
      id: row.id,
      orderNumber: row.order_number,
      customerName: row.customer_name,
      phone: row.phone,
      billNumber: row.bill_number,
      bookingDate: row.booking_date,
      dueDate: row.due_date,
      designerId: row.designer_id,
      designerName: designer?.full_name,
      masterTailorId: row.master_tailor_id,
      masterTailorName: masterTailor?.full_name,
      productCategory: row.product_category as OrderEntity["productCategory"],
      orderDetails: row.order_details,
      handWork: row.hand_work,
      machineWork: row.machine_work,
      purchaseRequired: row.purchase_required,
      paymentStatus: row.payment_status as OrderEntity["paymentStatus"],
      totalAmount: Number(row.total_amount),
      productionStatus: row.production_status,
      designerInstructions: row.designer_instructions,
      specialNotes: row.special_notes,
      images: row.order_images
        .sort((a, b) => a.slot - b.slot)
        .map((img) => ({
          id: img.id,
          orderId: row.id,
          slot: img.slot,
          storagePath: img.storage_path,
          originalFilename: img.original_filename,
          contentType: img.content_type,
          sizeBytes: img.size_bytes,
          uploadedBy: img.uploaded_by,
          createdAt: img.created_at,
        })),
      createdBy: row.created_by,
      updatedBy: row.updated_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Domain entity -> API response DTO. Async because resolving each image's
   * signed URL is an I/O call -- that's why this is a separate step from
   * toEntity() rather than folded into it: a domain entity should be cheap
   * and synchronous to construct.
   */
  async toDto(entity: OrderEntity): Promise<OrderDto> {
    const images = await Promise.all(
      entity.images.map(async (img) => ({
        ...img,
        url: await this.storageProvider.getSignedUrl(img.storagePath),
      })),
    );

    const amountPaid = 0; // Payment ledger lands in Phase 3; no payments yet to sum.

    return {
      ...entity,
      images,
      amountPaid,
      outstanding: Math.max(entity.totalAmount - amountPaid, 0),
    };
  }

  /** Create DTO -> persistence record. Shape translation only; the DTO is already validated by this point. */
  toNewOrderRecord(dto: CreateOrderDto, authUserId: string): NewOrderRecord {
    return {
      customer_name: dto.customerName,
      phone: dto.phone,
      bill_number: dto.billNumber,
      booking_date: dto.bookingDate ?? new Date().toISOString().slice(0, 10),
      due_date: dto.dueDate,
      designer_id: dto.designerId,
      master_tailor_id: dto.masterTailorId,
      product_category: dto.productCategory,
      order_details: dto.orderDetails,
      hand_work: dto.handWork,
      machine_work: dto.machineWork,
      purchase_required: dto.purchaseRequired,
      payment_status: dto.paymentStatus,
      total_amount: dto.totalAmount,
      production_status: dto.productionStatus,
      designer_instructions: dto.designerInstructions || null,
      special_notes: dto.specialNotes || null,
      created_by: authUserId,
      updated_by: authUserId,
    };
  }

  /** Update DTO fields (already RBAC-filtered by the service) -> a partial persistence update record. */
  toUpdateRecord(fields: Record<string, unknown>, authUserId: string): Record<string, unknown> {
    const updates: Record<string, unknown> = { updated_by: authUserId };
    for (const [key, value] of Object.entries(fields)) {
      const column = FIELD_TO_COLUMN[key];
      if (column) updates[column] = value;
    }
    return updates;
  }
}

export { FIELD_TO_COLUMN };
