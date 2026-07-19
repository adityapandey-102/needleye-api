import { z } from "zod";
import { GRANULAR_STATUS_VALUES } from "../constants/orderStatus";
import { PRODUCT_CATEGORY_VALUES, PAYMENT_STATUS_VALUES } from "../constants/productCategories";

/** Mirrors prototype's phoneNumber input filter + validateOrderForm() regex check. */
const phoneSchema = z.string().regex(/^\d{10}$/, "Enter a valid 10-digit number");

export const createOrderSchema = z.object({
  customerName: z.string().trim().min(1, "Please enter customer name"),
  phone: phoneSchema,
  billNumber: z.string().trim().min(1, "Please enter bill number"),
  bookingDate: z.string().min(1).optional(),
  dueDate: z.string().min(1, "Please select delivery due date"),
  designerId: z.string().uuid("Please select a designer"),
  masterTailorId: z.string().uuid("Please select a master"),
  productCategory: z.enum(PRODUCT_CATEGORY_VALUES, {
    errorMap: () => ({ message: "Please select a category" }),
  }),
  orderDetails: z.string().trim().min(1, "Please enter order details"),
  handWork: z.boolean().default(false),
  machineWork: z.boolean().default(false),
  purchaseRequired: z.boolean().default(false),
  paymentStatus: z.enum(PAYMENT_STATUS_VALUES, {
    errorMap: () => ({ message: "Please select payment status" }),
  }),
  totalAmount: z.coerce.number().min(0).default(0),
  productionStatus: z.enum(GRANULAR_STATUS_VALUES, {
    errorMap: () => ({ message: "Please select current status" }),
  }),
  designerInstructions: z.string().trim().optional(),
  specialNotes: z.string().trim().optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/**
 * Edit Order: everything optional (partial update), except the fields an
 * editor is not permitted to touch -- that's enforced by the capability
 * matrix in the API layer, not by this schema (a role-agnostic shape here
 * keeps one schema instead of one per role).
 */
export const updateOrderSchema = createOrderSchema.partial();

export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;

export const updateOrderStatusSchema = z.object({
  productionStatus: z.enum(GRANULAR_STATUS_VALUES),
  label: z.string().trim().optional(),
});

export type UpdateOrderStatusInput = z.infer<typeof updateOrderStatusSchema>;
