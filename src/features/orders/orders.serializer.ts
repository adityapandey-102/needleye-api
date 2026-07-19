import { storageProvider } from "../../shared/storage/storageProvider";
import type { OrderRow } from "./orders.types";

function toOne<T>(value: T[] | T | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export async function serializeOrder(row: OrderRow) {
  const designer = toOne(row.designer);
  const masterTailor = toOne(row.master_tailor);

  const images = await Promise.all(
    row.order_images
      .sort((a, b) => a.slot - b.slot)
      .map(async (img) => ({
        id: img.id,
        orderId: row.id,
        slot: img.slot,
        storagePath: img.storage_path,
        url: await storageProvider.getSignedUrl(img.storage_path),
        originalFilename: img.original_filename,
        contentType: img.content_type,
        sizeBytes: img.size_bytes,
        uploadedBy: img.uploaded_by,
        createdAt: img.created_at,
      })),
  );

  const amountPaid = 0; // Payment ledger lands in Phase 3; no payments yet to sum.

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
    productCategory: row.product_category,
    orderDetails: row.order_details,
    handWork: row.hand_work,
    machineWork: row.machine_work,
    purchaseRequired: row.purchase_required,
    paymentStatus: row.payment_status,
    totalAmount: Number(row.total_amount),
    amountPaid,
    outstanding: Math.max(Number(row.total_amount) - amountPaid, 0),
    productionStatus: row.production_status,
    designerInstructions: row.designer_instructions,
    specialNotes: row.special_notes,
    images,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export type SerializedOrder = Awaited<ReturnType<typeof serializeOrder>>;
