import { supabaseClient } from "../../common/database/supabase-client";
import { InternalError } from "../../common/errors/app-error";
import type { GranularStatus, Role } from "../../domain";

const ORDER_SELECT = `
  id, order_number, customer_name, phone, bill_number, booking_date, due_date,
  designer_id, master_tailor_id, product_category, order_details,
  hand_work, machine_work, purchase_required, payment_status, total_amount,
  production_status, designer_instructions, special_notes,
  created_by, updated_by, created_at, updated_at,
  designer:designer_id ( full_name ),
  master_tailor:master_tailor_id ( full_name ),
  order_images ( id, slot, storage_path, original_filename, content_type, size_bytes, uploaded_by, created_at )
`;

export type OrderRow = {
  id: string;
  order_number: string;
  customer_name: string;
  phone: string;
  bill_number: string;
  booking_date: string;
  due_date: string;
  designer_id: string;
  master_tailor_id: string;
  product_category: string;
  order_details: string;
  hand_work: boolean;
  machine_work: boolean;
  purchase_required: boolean;
  payment_status: string;
  total_amount: number;
  production_status: GranularStatus;
  designer_instructions: string | null;
  special_notes: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
  // Supabase-js can't infer to-one cardinality for a FK embed without
  // generated DB types, so it types this as an array even though PostgREST
  // returns a single object for a many-to-one relation.
  designer: { full_name: string }[] | { full_name: string } | null;
  master_tailor: { full_name: string }[] | { full_name: string } | null;
  order_images: Array<{
    id: string;
    slot: number;
    storage_path: string;
    original_filename: string | null;
    content_type: string | null;
    size_bytes: number | null;
    uploaded_by: string | null;
    created_at: string;
  }>;
};

/** Who is asking -- used to apply row-level visibility, mirroring the orders_select_scoped RLS policy. */
export interface RowScope {
  role: Role;
  userId: string;
}

export interface OrderListFilters {
  search?: string;
  status?: string;
  designerId?: string;
  masterTailorId?: string;
}

export interface NewOrderRecord {
  customer_name: string;
  phone: string;
  bill_number: string;
  booking_date: string;
  due_date: string;
  designer_id: string;
  master_tailor_id: string;
  product_category: string;
  order_details: string;
  hand_work: boolean;
  machine_work: boolean;
  purchase_required: boolean;
  payment_status: string;
  total_amount: number;
  production_status: GranularStatus;
  designer_instructions: string | null;
  special_notes: string | null;
  created_by: string;
  updated_by: string;
}

export interface NewImageRecord {
  order_id: string;
  slot: number;
  storage_path: string;
  original_filename: string | null;
  content_type: string | null;
  size_bytes: number | null;
  uploaded_by: string;
}

/** Persistence contract for the Orders module -- pure data access, no business rules. */
export interface OrdersRepository {
  findMany(scope: RowScope, filters: OrderListFilters): Promise<OrderRow[]>;
  findById(scope: RowScope, id: string): Promise<OrderRow | null>;
  findBasicById(id: string): Promise<{ id: string; designer_id: string } | null>;
  create(data: NewOrderRecord): Promise<OrderRow>;
  update(id: string, data: Record<string, unknown>): Promise<OrderRow>;
  upsertImage(data: NewImageRecord): Promise<void>;
  findImage(orderId: string, slot: number): Promise<{ storage_path: string } | null>;
  deleteImage(orderId: string, slot: number): Promise<void>;
}

export class SupabaseOrdersRepository implements OrdersRepository {
  /** Applies row-level visibility for the caller's role -- owner_manager/accountant unscoped, designer/master_tailor limited to their own orders. */
  private applyRowScope<Q extends { eq: (column: string, value: string) => Q }>(query: Q, scope: RowScope): Q {
    if (scope.role === "designer") return query.eq("designer_id", scope.userId);
    if (scope.role === "master_tailor") return query.eq("master_tailor_id", scope.userId);
    return query;
  }

  async findMany(scope: RowScope, filters: OrderListFilters): Promise<OrderRow[]> {
    let query = supabaseClient.from("orders").select(ORDER_SELECT).order("created_at", { ascending: false });
    query = this.applyRowScope(query, scope);

    if (filters.search?.trim()) {
      const term = `%${filters.search.trim()}%`;
      query = query.or(`customer_name.ilike.${term},bill_number.ilike.${term},order_number.ilike.${term}`);
    }
    if (filters.status) query = query.eq("production_status", filters.status);
    if (filters.designerId) query = query.eq("designer_id", filters.designerId);
    if (filters.masterTailorId) query = query.eq("master_tailor_id", filters.masterTailorId);

    const { data, error } = await query;
    if (error) throw new InternalError("Failed to load orders");
    return data as OrderRow[];
  }

  async findById(scope: RowScope, id: string): Promise<OrderRow | null> {
    let query = supabaseClient.from("orders").select(ORDER_SELECT).eq("id", id);
    query = this.applyRowScope(query, scope);

    const { data, error } = await query.maybeSingle();
    if (error) throw new InternalError("Failed to load order");
    return data as OrderRow | null;
  }

  async findBasicById(id: string): Promise<{ id: string; designer_id: string } | null> {
    const { data, error } = await supabaseClient.from("orders").select("id, designer_id").eq("id", id).maybeSingle();
    if (error) throw new InternalError("Failed to load order");
    return data;
  }

  async create(data: NewOrderRecord): Promise<OrderRow> {
    const { data: row, error } = await supabaseClient.from("orders").insert(data).select(ORDER_SELECT).single();
    if (error) throw new InternalError("Failed to create order");
    return row as OrderRow;
  }

  async update(id: string, data: Record<string, unknown>): Promise<OrderRow> {
    const { data: row, error } = await supabaseClient
      .from("orders")
      .update(data)
      .eq("id", id)
      .select(ORDER_SELECT)
      .single();
    if (error) throw new InternalError("Failed to save order");
    return row as OrderRow;
  }

  async upsertImage(data: NewImageRecord): Promise<void> {
    const { error } = await supabaseClient.from("order_images").upsert(data, { onConflict: "order_id,slot" });
    if (error) throw new InternalError("Failed to save uploaded image");
  }

  async findImage(orderId: string, slot: number): Promise<{ storage_path: string } | null> {
    const { data } = await supabaseClient
      .from("order_images")
      .select("storage_path")
      .eq("order_id", orderId)
      .eq("slot", slot)
      .maybeSingle();
    return data;
  }

  async deleteImage(orderId: string, slot: number): Promise<void> {
    await supabaseClient.from("order_images").delete().eq("order_id", orderId).eq("slot", slot);
  }
}
