import {
  createOrderSchema,
  updateOrderSchema,
  getCapabilityScope,
  type CreateOrderInput,
  type Profile,
  type UpdateOrderInput,
} from "@needleye/shared";
import { supabaseAdmin } from "../../shared/supabaseAdmin";
import { storageProvider } from "../../shared/storage/storageProvider";
import { BadRequestError, ForbiddenError, InternalError, NotFoundError } from "../../shared/errors";
import { ORDER_SELECT, type OrderRow } from "./orders.types";
import { serializeOrder, type SerializedOrder } from "./orders.serializer";

interface AuthContext {
  profile: Profile;
  authUserId: string;
}

export interface OrderListFilters {
  search?: string;
  status?: string;
  designerId?: string;
  masterTailorId?: string;
}

/** Row-level scope filter matching the orders_select_scoped RLS policy. */
function applyRowScope<Q extends { eq: (column: string, value: string) => Q }>(query: Q, ctx: AuthContext): Q {
  if (ctx.profile.role === "designer") return query.eq("designer_id", ctx.authUserId);
  if (ctx.profile.role === "master_tailor") return query.eq("master_tailor_id", ctx.authUserId);
  return query; // owner_manager / accountant: unscoped
}

export async function listOrders(ctx: AuthContext, filters: OrderListFilters): Promise<SerializedOrder[]> {
  let query = supabaseAdmin.from("orders").select(ORDER_SELECT).order("created_at", { ascending: false });
  query = applyRowScope(query, ctx);

  if (filters.search?.trim()) {
    const term = `%${filters.search.trim()}%`;
    query = query.or(`customer_name.ilike.${term},bill_number.ilike.${term},order_number.ilike.${term}`);
  }
  if (filters.status) query = query.eq("production_status", filters.status);
  if (filters.designerId) query = query.eq("designer_id", filters.designerId);
  if (filters.masterTailorId) query = query.eq("master_tailor_id", filters.masterTailorId);

  const { data, error } = await query;
  if (error) throw new InternalError("Failed to load orders");

  return Promise.all((data as OrderRow[]).map(serializeOrder));
}

export async function getOrder(ctx: AuthContext, orderId: string): Promise<SerializedOrder> {
  let query = supabaseAdmin.from("orders").select(ORDER_SELECT).eq("id", orderId);
  query = applyRowScope(query, ctx);

  const { data, error } = await query.maybeSingle();
  if (error) throw new InternalError("Failed to load order");
  if (!data) throw new NotFoundError("Order not found");

  return serializeOrder(data as OrderRow);
}

export async function createOrder(ctx: AuthContext, rawInput: unknown): Promise<SerializedOrder> {
  const input: CreateOrderInput = createOrderSchema.parse(rawInput);

  const { data, error } = await supabaseAdmin
    .from("orders")
    .insert({
      customer_name: input.customerName,
      phone: input.phone,
      bill_number: input.billNumber,
      booking_date: input.bookingDate ?? new Date().toISOString().slice(0, 10),
      due_date: input.dueDate,
      designer_id: input.designerId,
      master_tailor_id: input.masterTailorId,
      product_category: input.productCategory,
      order_details: input.orderDetails,
      hand_work: input.handWork,
      machine_work: input.machineWork,
      purchase_required: input.purchaseRequired,
      payment_status: input.paymentStatus,
      total_amount: input.totalAmount,
      production_status: input.productionStatus,
      designer_instructions: input.designerInstructions || null,
      special_notes: input.specialNotes || null,
      created_by: ctx.authUserId,
      updated_by: ctx.authUserId,
    })
    .select(ORDER_SELECT)
    .single();

  if (error) throw new InternalError("Failed to create order");
  return serializeOrder(data as OrderRow);
}

const PRICING_FIELDS = ["totalAmount", "designerId", "masterTailorId"] as const;
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

export async function updateOrder(ctx: AuthContext, orderId: string, rawInput: unknown): Promise<SerializedOrder> {
  const parsed: UpdateOrderInput = updateOrderSchema.parse(rawInput);

  // productionStatus is intentionally not editable here -- status changes
  // (Kanban drag / detail-page status change) go through a dedicated
  // endpoint in Phase 4 that enforces design-stage vs production-stage RBAC.
  const { productionStatus: _ignored, ...fields } = parsed;
  const submittedKeys = Object.keys(fields) as Array<keyof typeof fields>;
  if (submittedKeys.length === 0) throw new BadRequestError("No editable fields to update");

  const customerProductScope = getCapabilityScope(ctx.profile.role, "orders:edit:customer_product_fields");
  const pricingScope = getCapabilityScope(ctx.profile.role, "orders:edit:pricing_assignment");

  const touchesPricing = submittedKeys.some((k) => (PRICING_FIELDS as readonly string[]).includes(k));
  const touchesCustomerProduct = submittedKeys.some((k) => !(PRICING_FIELDS as readonly string[]).includes(k));

  if (touchesPricing && pricingScope === false) {
    throw new ForbiddenError("Your role cannot edit pricing or assignment fields");
  }
  if (touchesCustomerProduct && customerProductScope === false) {
    throw new ForbiddenError("Your role cannot edit order details");
  }

  // Both remaining capabilities are either true or "assigned" at this point
  // for the fields actually being touched -- if either is scoped, verify
  // the caller is the order's assigned designer before allowing the write.
  const needsOwnershipCheck =
    (touchesPricing && pricingScope === "assigned") || (touchesCustomerProduct && customerProductScope === "assigned");

  const { data: existing, error: fetchError } = await supabaseAdmin
    .from("orders")
    .select("id, designer_id")
    .eq("id", orderId)
    .maybeSingle();

  if (fetchError) throw new InternalError("Failed to load order");
  if (!existing) throw new NotFoundError("Order not found");
  if (needsOwnershipCheck && existing.designer_id !== ctx.authUserId) {
    throw new ForbiddenError("You can only edit orders assigned to you");
  }

  const updates: Record<string, unknown> = { updated_by: ctx.authUserId };
  for (const key of submittedKeys) {
    const column = FIELD_TO_COLUMN[key];
    if (!column) continue;
    updates[column] = fields[key];
  }

  const { data, error } = await supabaseAdmin
    .from("orders")
    .update(updates)
    .eq("id", orderId)
    .select(ORDER_SELECT)
    .single();

  if (error) throw new InternalError("Failed to save order");
  return serializeOrder(data as OrderRow);
}

async function assertOrderEditable(ctx: AuthContext & { capabilityScope?: boolean | "assigned" }, orderId: string) {
  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select("id, designer_id")
    .eq("id", orderId)
    .maybeSingle();

  if (error) throw new InternalError("Failed to load order");
  if (!order) throw new NotFoundError("Order not found");
  if (ctx.capabilityScope === "assigned" && order.designer_id !== ctx.authUserId) {
    throw new ForbiddenError("You can only edit orders assigned to you");
  }
}

export async function uploadOrderImage(
  ctx: AuthContext & { capabilityScope?: boolean | "assigned" },
  orderId: string,
  slot: number,
  file: Express.Multer.File,
): Promise<{ storagePath: string; url: string }> {
  if (!Number.isInteger(slot) || slot < 1 || slot > 4) {
    throw new BadRequestError("slot must be an integer between 1 and 4");
  }
  if (!file.mimetype.startsWith("image/")) {
    throw new BadRequestError("Please upload an image file");
  }

  await assertOrderEditable(ctx, orderId);

  const storagePath = await storageProvider.upload(orderId, slot, file);

  const { error } = await supabaseAdmin.from("order_images").upsert(
    {
      order_id: orderId,
      slot,
      storage_path: storagePath,
      original_filename: file.originalname,
      content_type: file.mimetype,
      size_bytes: file.size,
      uploaded_by: ctx.authUserId,
    },
    { onConflict: "order_id,slot" },
  );

  if (error) throw new InternalError("Failed to save uploaded image");
  return { storagePath, url: await storageProvider.getSignedUrl(storagePath) };
}

export async function deleteOrderImage(
  ctx: AuthContext & { capabilityScope?: boolean | "assigned" },
  orderId: string,
  slot: number,
): Promise<void> {
  await assertOrderEditable(ctx, orderId);

  const { data: image } = await supabaseAdmin
    .from("order_images")
    .select("storage_path")
    .eq("order_id", orderId)
    .eq("slot", slot)
    .maybeSingle();

  if (image) {
    await storageProvider.delete(image.storage_path);
    await supabaseAdmin.from("order_images").delete().eq("order_id", orderId).eq("slot", slot);
  }
}
