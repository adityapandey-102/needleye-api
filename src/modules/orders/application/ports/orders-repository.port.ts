import type { PriceChangeDecision, PriceState } from "../../domain/order-pricing.rules";
import type { OrderPriceChangeEntity } from "../../domain/order-price-change.entity";
import type { GranularStatus, PaymentStatus, ProductCategory, Role } from "../../../../domain";
import type { OrderEntity } from "../../domain/order.entity";
import type { OrderStatusHistoryEntity } from "../../domain/order-status-history.entity";

/**
 * What the delivery-capacity rule needs, read under the per-date lock:
 * `booked` = orders already on the due date (excluding the one being edited),
 * `previousDueDate` = that order's current date on an edit, null on create.
 */
export interface DueDateCapacityFacts {
  booked: number;
  previousDueDate: string | null;
}

/** A booking onto a full delivery day, confirmed with the Production Manager -- logged with the order's create / edit. */
export interface DeliveryOverride {
  dueDate: string;
  /** Orders already on that day before this one. */
  bookedBefore: number;
  capacity: number;
}

/**
 * Throws to veto a write; returns the override when the write books a full
 * day with the PM's OK, so the repository logs it with the change (in the same
 * transaction). See OrdersRepositoryPort.create/update.
 */
export type DueDateCapacityGuard = (facts: DueDateCapacityFacts) => DeliveryOverride | void;

/**
 * "This order is for that lead": the lead is marked Converted in the SAME
 * transaction as the order insert (the Leads module's convertLeadInTransaction).
 * If it can't be converted, nothing is saved.
 */
export interface LeadLink {
  leadId: string;
  actorId: string;
  actor: "owner" | "designer";
}

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
  /** Dashboard/list filter: active | production | completed | ready | delivered | delivered_this_month | pending_payment | payment_overdue | payment_upcoming | overdue | urgent | this_month. */
  bucket?: string;
  /**
   * Only orders created on or after this shop day (YYYY-MM-DD, business
   * timezone). The Kanban board uses it to show just the last 2 months.
   */
  createdFrom?: string;
  /** Only orders DUE on this day (YYYY-MM-DD) -- the delivery calendar's day list. */
  dueOn?: string;
}

/** Offset pagination for the orders list -- keeps the default list response bounded regardless of how many orders exist. */
export interface OrderListPage {
  limit: number;
  offset: number;
}

export interface NewOrderRecord {
  customerName: string;
  phone: string;
  billNumber: string;
  bookingDate: string;
  dueDate: string;
  nextPaymentDate: string | null;
  designerId: string;
  masterTailorId: string;
  productCategory: ProductCategory;
  orderDetails: string;
  handWork: boolean;
  machineWork: boolean;
  purchaseRequired: boolean;
  paymentStatus: PaymentStatus;
  /** Null = no price yet. A price given at creation is recorded as the first "set" in the price history. */
  totalAmount: string | null;
  productionStatus: GranularStatus;
  designerInstructions: string | null;
  specialNotes: string | null;
  createdBy: string;
  updatedBy: string;
}

export interface UpdateOrderRecord {
  customerName?: string;
  phone?: string;
  billNumber?: string;
  bookingDate?: string;
  dueDate?: string;
  nextPaymentDate?: string | null;
  designerId?: string;
  masterTailorId?: string;
  productCategory?: ProductCategory;
  orderDetails?: string;
  handWork?: boolean;
  machineWork?: boolean;
  purchaseRequired?: boolean;
  // The total (and so the payment status) never changes through an edit --
  // only through changePrice() (ADR 0008).
  designerInstructions?: string | null;
  specialNotes?: string | null;
  updatedBy: string;
}

/** Lightweight projection used for the ownership check and the fully-paid ledger reconciliation -- not a full entity load. */
export interface OrderBasicInfo {
  id: string;
  designerId: string;
  masterTailorId: string;
  totalAmount: string | null;
  paymentStatus: PaymentStatus;
}

export interface NewImageRecord {
  orderId: string;
  slot: number;
  storagePath: string;
  originalFilename: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  uploadedBy: string;
}

export interface OrderImageInfo {
  storagePath: string;
}

/**
 * Unconditional dashboard aggregates for the caller's row scope -- computed
 * the same way for every role; the Presenter (not the repository) decides
 * which fields a given role is allowed to see.
 */
export interface OrderStatsRaw {
  total: number;
  active: number;
  /** Every delivered order ever. Kept for older web builds; the dashboard now shows deliveredThisMonth. */
  completed: number;
  /** Orders that reached Delivered since the 1st of this month (shop timezone). */
  deliveredThisMonth: number;
  /** Orders currently in Ready (finished, waiting for the customer). */
  ready: number;
  thisMonth: number;
  inProduction: number;
  overdue: number;
  urgent: number;
  pendingPayments: number;
  /** Orders with no price yet (ADR 0008). */
  notPriced: number;
  /** Money as 2dp strings. */
  collectedRevenue: string;
  outstandingRevenue: string;
}

/** One accounting period's collected revenue, for the monthly revenue report. */
export interface RevenuePeriod {
  /** First day of the accounting period (YYYY-MM-DD). */
  periodStart: string;
  /** SUM(payments.amount) with paid_at inside this period. Money as a 2dp string. */
  collected: string;
  /** Number of payment entries recorded in this period. */
  paymentCount: number;
}

/**
 * A designer/master-tailor's workload snapshot for the staff report. The
 * "this week" throughput fields (bookedThisWeek/completedThisWeek) are
 * time-windowed; the rest are the CURRENT state of every order assigned to
 * them (their live board), computed the same way the dashboard stats are.
 */
export interface StaffReportSummary {
  /**
   * All metrics are scoped to the orders this person BOOKED in the selected
   * month (the month's cohort), showing where that cohort stands now.
   */
  booked: number;
  active: number;
  inProduction: number;
  completed: number;
  overdue: number;
  urgent: number;
  paymentPendingCount: number;
  /** Money as a 2dp string. */
  paymentPendingAmount: string;
}

/** One week's throughput for the 6-month graph (Monday-started weeks, oldest first). */
export interface StaffWeeklyPoint {
  weekStart: string;
  booked: number;
  completed: number;
}

export interface StaffReportRaw {
  staff: { id: string; fullName: string; role: "designer" | "master_tailor" };
  summary: StaffReportSummary;
  weekly: StaffWeeklyPoint[];
}

/** One payment-ledger audit event (created/updated/deleted), joined with the actor + order for display. */
/** One payment_audit_log row (ADR 0008): typed values, money as 2dp strings. */
export interface LedgerEventRaw {
  id: string;
  action: "created" | "updated" | "deleted";
  createdAt: string;
  actorName: string | null;
  orderId: string | null;
  orderNumber: string | null;
  amount: string;
  method: string;
  paidAt: string;
  previousAmount: string | null;
  previousMethod: string | null;
  previousPaidAt: string | null;
}

export interface LedgerEventsResult {
  events: LedgerEventRaw[];
  total: number;
}

/** Persistence contract for the Orders module -- pure data access, no business rules. */
export interface OrdersRepositoryPort {
  /** One page of orders. Images are NOT loaded (entities have `images: []`) -- lists never show them. */
  findMany(scope: RowScope, filters: OrderListFilters, page: OrderListPage): Promise<OrderEntity[]>;
  /** Total orders matching the same scope+filters as findMany, ignoring pagination -- backs the list's total count. */
  countMany(scope: RowScope, filters: OrderListFilters): Promise<number>;
  findById(scope: RowScope, id: string): Promise<OrderEntity | null>;
  /** Loads an order ignoring row scope -- backs the authenticated view-only path (any logged-in user can read a single order, payments stripped by the presenter). */
  findAnyById(id: string): Promise<OrderEntity | null>;
  getStats(scope: RowScope): Promise<OrderStatsRaw>;
  /** Collected revenue grouped into accounting periods (most recent first), for the revenue report. */
  getMonthlyRevenue(scope: RowScope, cycleStartDay: number, range: { from: string; to: string }): Promise<RevenuePeriod[]>;
  /**
   * Per-staff workload report (Owner/Manager only). Returns null if the id
   * isn't an active designer/master_tailor. Computes the current-state counts +
   * a weekly throughput series for the given month window (`range`), on demand
   * for ONE person -- never all staff at once (the UI drills down: role ->
   * person -> month -> this call).
   */
  getStaffReport(staffId: string, range: { from: string; to: string }): Promise<StaffReportRaw | null>;
  /** Paginated payment-ledger events (payment_audit_log: created/updated/deleted) in a date range, newest first -- backs the ledger-activity history. */
  getLedgerEvents(range: { from: string; to: string }, page: OrderListPage): Promise<LedgerEventsResult>;
  findBasicById(id: string): Promise<OrderBasicInfo | null>;
  /**
   * Orders per due date in [from, to] (inclusive, only days with at least one),
   * across EVERY order -- deliberately NOT row-scoped: delivery capacity is
   * shop-wide, and the result is bare counts, never order details, so a designer
   * seeing other designers' totals leaks nothing. `excludeOrderId` leaves one
   * order out (the one being edited, so it doesn't count against itself).
   */
  countOrdersDueByDay(range: { from: string; to: string }, excludeOrderId?: string): Promise<{ date: string; count: number }[]>;
  /**
   * Inserts the order + its first status-history row + its "created" audit
   * row (and, when priced at booking, its first price-history row) in one transaction.
   * `assertDueDateCapacity`, when given, runs inside that transaction AFTER a
   * per-date lock is taken, with how many orders already sit on the due date --
   * so two people booking the last slot at once serialise, and the second sees
   * the first. It throws to veto the insert. With `leadLink`, the lead is
   * converted in the same transaction (or the whole create is refused).
   */
  create(data: NewOrderRecord, assertDueDateCapacity?: DueDateCapacityGuard, leadLink?: LeadLink): Promise<OrderEntity>;
  /**
   * Updates the order, bumps its `version`, and logs the changed fields
   * (before -> after, order_audit_log) in the same transaction -- against the
   * row it locks first, so the "before" values are exact. If `expectedVersion` is given,
   * the write is guarded on it (optimistic lock) and throws ORDER_MODIFIED
   * when the stored version has moved on -- i.e. someone else edited it first.
   * `assertDueDateCapacity` (only meaningful when `data.dueDate` is set) runs
   * under the per-date lock with the day's count EXCLUDING this order and the
   * order's current due date -- see create().
   */
  update(
    id: string,
    data: UpdateOrderRecord,
    expectedVersion?: number,
    assertDueDateCapacity?: DueDateCapacityGuard,
  ): Promise<OrderEntity>;
  /**
   * Updates production_status and appends one order_status_history row,
   * atomically (one DB transaction, order row locked). Enforces forward-only.
   * `assertTransition`, when given, is called with the LOCKED current status
   * before anything is written -- it throws to veto the move (e.g. the
   * no-skipping-past-a-gated-stage rule), rolling the transaction back.
   */
  updateStatus(
    id: string,
    status: GranularStatus,
    changedBy: string,
    assertTransition?: (current: GranularStatus) => void,
  ): Promise<OrderEntity>;
  listStatusHistory(orderId: string): Promise<OrderStatusHistoryEntity[]>;
  /**
   * Sets / raises / discounts the order's total and appends one
   * order_price_history row, atomically, with the order row locked. `decide`
   * gets the LOCKED state (current total, stage, designer, collected) and
   * returns the change's kind + reason -- or throws to veto it (ADR 0008).
   */
  changePrice(
    id: string,
    request: { newTotal: string; changedBy: string },
    decide: (state: PriceState) => PriceChangeDecision,
  ): Promise<OrderPriceChangeEntity>;
  /** An order's price history, newest first. */
  listPriceHistory(orderId: string): Promise<OrderPriceChangeEntity[]>;
  upsertImage(data: NewImageRecord): Promise<void>;
  findImage(orderId: string, slot: number): Promise<OrderImageInfo | null>;
  /** Removes the image reference and logs it (order_audit_log) in one transaction. */
  deleteImage(orderId: string, slot: number, actorId: string): Promise<void>;
  /** Real (not cached) sum of the payment ledger -- used to compute amountPaid/outstanding and the fully_paid consistency check. */
  sumPaymentsForOrder(orderId: string): Promise<string>;
  /** Batched form of sumPaymentsForOrder, for listOrders -- one grouped aggregate query, not one query per row. Money as 2dp strings. */
  sumPaymentsForOrders(orderIds: string[]): Promise<Record<string, string>>;
}
