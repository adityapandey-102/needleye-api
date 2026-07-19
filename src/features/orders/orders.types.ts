import type { GranularStatus } from "../../shared/domain";

export const ORDER_SELECT = `
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
