import { relations } from "drizzle-orm";
// Cross-module Infrastructure-only read: `profiles` is owned by the Users
// module's schema. See docs/adr/0003-per-module-schema-ownership.md.
import { profiles } from "../../users/infrastructure/profile.schema";
import { orders } from "./order.schema";
import { orderImages } from "./order-image.schema";

/**
 * Relations exist purely so the relational query API (db.query.orders.findMany
 * with `with: {...}`) can eager-load designer/masterTailor/images in one
 * round trip instead of N+1 -- Drizzle can't infer these from the DB's own
 * FK constraints, so they're declared explicitly here. Two separate
 * relations to `profiles` need distinct relationNames since both FKs target
 * the same table. Kept in its own file (separate from order.schema.ts) per
 * this module's explicit file-naming convention -- see the README's
 * directory tree.
 */
export const ordersRelations = relations(orders, ({ one, many }) => ({
  designer: one(profiles, {
    fields: [orders.designerId],
    references: [profiles.id],
    relationName: "orderDesigner",
  }),
  masterTailor: one(profiles, {
    fields: [orders.masterTailorId],
    references: [profiles.id],
    relationName: "orderMasterTailor",
  }),
  images: many(orderImages),
}));

export const orderImagesRelations = relations(orderImages, ({ one }) => ({
  order: one(orders, { fields: [orderImages.orderId], references: [orders.id] }),
}));
