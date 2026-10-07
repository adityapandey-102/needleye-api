import { z } from "zod";
import { GRANULAR_STATUS_VALUES, PRODUCT_CATEGORY_VALUES } from "../../../../domain";
import { moneyField } from "../../../../common/money/money-schema";

/** Mirrors prototype's phoneNumber input filter + validateOrderForm() regex check. */
const phoneSchema = z.string().regex(/^\d{10}$/, "Enter a valid 10-digit number");

export const createOrderDtoSchema = z.object({
  customerName: z.string().trim().min(1, "Please enter customer name"),
  phone: phoneSchema,
  billNumber: z.string().trim().min(1, "Please enter bill number"),
  bookingDate: z.string().min(1).optional(),
  dueDate: z.string().min(1, "Please select delivery due date"),
  // A date string to set the next-expected-payment date, or null to clear it, or omitted to leave unchanged (on edit).
  nextPaymentDate: z.string().min(1).nullable().optional(),
  designerId: z.string().uuid("Please select a designer"),
  masterTailorId: z.string().uuid("Please select a master"),
  productCategory: z.enum(PRODUCT_CATEGORY_VALUES, {
    errorMap: () => ({ message: "Please select a category" }),
  }),
  orderDetails: z.string().trim().min(1, "Please enter order details"),
  handWork: z.boolean().default(false),
  machineWork: z.boolean().default(false),
  purchaseRequired: z.boolean().default(false),
  // Payment status is DERIVED from the ledger, never submitted -- see
  // derivePaymentStatus. A new order normally has NO price (null): it's priced
  // afterwards via PUT /orders/:id/price (ADR 0008). A total given here is the
  // first price -- allowed only for roles that may set one (owner, accountant,
  // the order's own designer) and recorded in the price history.
  totalAmount: moneyField.nullable().default(null),
  productionStatus: z.enum(GRANULAR_STATUS_VALUES, {
    errorMap: () => ({ message: "Please select current status" }),
  }),
  designerInstructions: z.string().trim().optional(),
  specialNotes: z.string().trim().optional(),
  /**
   * Not an order field -- the creator's acknowledgement that the due date's day
   * is full (DELIVERY_DAY_CAPACITY reached) and the Production Manager agreed to
   * take it anyway. Required to book a full day (else 409 DELIVERY_DAY_FULL);
   * using it is audited as order.delivery_override. Never stored on the order.
   */
  confirmedWithProductionManager: z.boolean().optional(),
  /**
   * Not an order field -- "this order is for that lead". The lead is marked
   * Converted in the same transaction; if it can't be (not the caller's, not
   * yet received, already closed) the order isn't created (409 LEAD_NOT_CONVERTIBLE).
   */
  leadId: z.string().uuid().optional(),
});

export type CreateOrderDto = z.infer<typeof createOrderDtoSchema>;
