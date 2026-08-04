import type { GranularStatus, PaymentStatus, ProductCategory, Role } from "../../../../domain";
import type { OrderEntity } from "../../domain/order.entity";
import type { OrderStatusHistoryEntity } from "../../domain/order-status-history.entity";

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
  /** Dashboard/list filter: active | production | completed | ready | delivered | pending_payment | payment_overdue | payment_upcoming | overdue | urgent | this_month. */
  bucket?: string;
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
  totalAmount: number;
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
  paymentStatus?: PaymentStatus;
  totalAmount?: number;
  designerInstructions?: string | null;
  specialNotes?: string | null;
  updatedBy: string;
}

/** Lightweight projection used for the ownership check and the fully-paid ledger reconciliation -- not a full entity load. */
export interface OrderBasicInfo {
  id: string;
  designerId: string;
  masterTailorId: string;
  totalAmount: number;
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
  completed: number;
  thisMonth: number;
  inProduction: number;
  overdue: number;
  urgent: number;
  pendingPayments: number;
  collectedRevenue: number;
  outstandingRevenue: number;
}

/** One accounting period's collected revenue, for the monthly revenue report. */
export interface RevenuePeriod {
  /** First day of the accounting period (YYYY-MM-DD). */
  periodStart: string;
  /** SUM(payments.amount) with paid_at inside this period. */
  collected: number;
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
  paymentPendingAmount: number;
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
export interface LedgerEventRaw {
  id: string;
  action: string;
  createdAt: string;
  actorName: string | null;
  orderId: string | null;
  orderNumber: string | null;
  metadata: Record<string, unknown> | null;
}

export interface LedgerEventsResult {
  events: LedgerEventRaw[];
  total: number;
}

/** Persistence contract for the Orders module -- pure data access, no business rules. */
export interface OrdersRepositoryPort {
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
  /** Paginated payment-ledger audit events (created/updated/deleted) in a date range, newest first -- backs the ledger-activity history. */
  getLedgerEvents(range: { from: string; to: string }, page: OrderListPage): Promise<LedgerEventsResult>;
  findBasicById(id: string): Promise<OrderBasicInfo | null>;
  create(data: NewOrderRecord): Promise<OrderEntity>;
  /**
   * Updates the order and bumps its `version`. If `expectedVersion` is given,
   * the write is guarded on it (optimistic lock) and throws ORDER_MODIFIED
   * when the stored version has moved on -- i.e. someone else edited it first.
   */
  update(id: string, data: UpdateOrderRecord, expectedVersion?: number): Promise<OrderEntity>;
  /** Updates production_status and appends one order_status_history row, atomically (one DB transaction). */
  updateStatus(id: string, status: GranularStatus, changedBy: string): Promise<OrderEntity>;
  listStatusHistory(orderId: string): Promise<OrderStatusHistoryEntity[]>;
  upsertImage(data: NewImageRecord): Promise<void>;
  findImage(orderId: string, slot: number): Promise<OrderImageInfo | null>;
  deleteImage(orderId: string, slot: number): Promise<void>;
  /** Real (not cached) sum of the payment ledger -- used to compute amountPaid/outstanding and the fully_paid consistency check. */
  sumPaymentsForOrder(orderId: string): Promise<number>;
  /** Batched form of sumPaymentsForOrder, for listOrders -- one grouped aggregate query, not one query per row. */
  sumPaymentsForOrders(orderIds: string[]): Promise<Record<string, number>>;
}
