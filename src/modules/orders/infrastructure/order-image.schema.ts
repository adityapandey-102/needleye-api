import { pgTable, uuid, smallint, text, integer, timestamp, unique } from "drizzle-orm/pg-core";

/** The Orders module owns `order_images` too -- a child table of `orders`, never queried independently of an order. */
export const orderImages = pgTable(
  "order_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").notNull(),
    slot: smallint("slot").notNull(),
    storagePath: text("storage_path").notNull(),
    originalFilename: text("original_filename"),
    contentType: text("content_type"),
    sizeBytes: integer("size_bytes"),
    uploadedBy: uuid("uploaded_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [unique().on(table.orderId, table.slot)],
);
