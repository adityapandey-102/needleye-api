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
  pendingPayments: number;
  collectedRevenue: number;
  outstandingRevenue: number;
}

/** Persistence contract for the Orders module -- pure data access, no business rules. */
export interface OrdersRepositoryPort {
  findMany(scope: RowScope, filters: OrderListFilters, page: OrderListPage): Promise<OrderEntity[]>;
  /** Total orders matching the same scope+filters as findMany, ignoring pagination -- backs the list's total count. */
  countMany(scope: RowScope, filters: OrderListFilters): Promise<number>;
  findById(scope: RowScope, id: string): Promise<OrderEntity | null>;
  getStats(scope: RowScope): Promise<OrderStatsRaw>;
  findBasicById(id: string): Promise<OrderBasicInfo | null>;
  create(data: NewOrderRecord): Promise<OrderEntity>;
  update(id: string, data: UpdateOrderRecord): Promise<OrderEntity>;
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
