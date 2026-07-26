import { and, desc, eq, ilike, inArray, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "../../../common/database/drizzle-client";
import { orders } from "./order.schema";
import { orderImages } from "./order-image.schema";
import { orderStatusHistory } from "./order-status-history.schema";
// Cross-module Infrastructure-only read of Payments' schema, for the ledger
// sum aggregates below -- see docs/adr/0003-per-module-schema-ownership.md.
import { payments } from "../../payments/infrastructure/payments.schema";
// Cross-module Infrastructure-only read: `profiles` is owned by the Users
// module's schema. See docs/adr/0003-per-module-schema-ownership.md.
import { profiles } from "../../users/infrastructure/profile.schema";
import { InternalError } from "../../../common/errors/app-error";
import { CANONICAL_TO_GRANULAR, COMPLETED_CANONICAL_STAGES, granularLabel, type GranularStatus } from "../../../domain";
import { OrderMapper, type OrderQueryResult } from "./order.mapper";
import { OrderStatusHistoryMapper, type OrderStatusHistoryRow } from "./order-status-history.mapper";
import type { OrderEntity } from "../domain/order.entity";
import type { OrderStatusHistoryEntity } from "../domain/order-status-history.entity";
import type {
  OrdersRepositoryPort,
  RowScope,
  OrderListFilters,
  OrderListPage,
  NewOrderRecord,
  UpdateOrderRecord,
  NewImageRecord,
  OrderBasicInfo,
  OrderImageInfo,
  OrderStatsRaw,
} from "../application/ports/orders-repository.port";

/** The granular values a Kanban card sits on once it reaches the "ready"/"delivered" canonical columns -- see domain/order-status.ts. */
const COMPLETED_STATUSES = COMPLETED_CANONICAL_STAGES.map((stage) => CANONICAL_TO_GRANULAR[stage]);

export class DrizzleOrdersRepository implements OrdersRepositoryPort {
  /** Applies row-level visibility for the caller's role -- owner_manager/accountant unscoped, designer/master_tailor limited to their own orders. */
  private rowScopeCondition(scope: RowScope) {
    if (scope.role === "designer") return eq(orders.designerId, scope.userId);
    if (scope.role === "master_tailor") return eq(orders.masterTailorId, scope.userId);
    return undefined;
  }

  /** Row scope + filters, shared by findMany and countMany so the page and its total always agree. */
  private listConditions(scope: RowScope, filters: OrderListFilters) {
    const conditions = [this.rowScopeCondition(scope)];

    if (filters.search?.trim()) {
      const term = `%${filters.search.trim()}%`;
      conditions.push(or(ilike(orders.customerName, term), ilike(orders.billNumber, term), ilike(orders.orderNumber, term)));
    }
    if (filters.status) conditions.push(eq(orders.productionStatus, filters.status as OrderEntity["productionStatus"]));
    if (filters.designerId) conditions.push(eq(orders.designerId, filters.designerId));
    if (filters.masterTailorId) conditions.push(eq(orders.masterTailorId, filters.masterTailorId));

    return and(...conditions);
  }

  async findMany(scope: RowScope, filters: OrderListFilters, page: OrderListPage): Promise<OrderEntity[]> {
    try {
      // One round trip for every order plus its designer/masterTailor/images --
      // not N+1 -- via Drizzle's relational query API (see order.relations.ts).
      // limit/offset keep this bounded regardless of total order count.
      const rows = await db.query.orders.findMany({
        where: this.listConditions(scope, filters),
        orderBy: [desc(orders.createdAt)],
        with: { designer: true, masterTailor: true, images: true },
        limit: page.limit,
        offset: page.offset,
      });
      return (rows as OrderQueryResult[]).map((row) => OrderMapper.toEntity(row));
    } catch (error) {
      throw new InternalError("Failed to load orders", error);
    }
  }

  async countMany(scope: RowScope, filters: OrderListFilters): Promise<number> {
    try {
      const [row] = await db
        .select({ total: sql<string>`count(*)` })
        .from(orders)
        .where(this.listConditions(scope, filters));
      return row ? Number(row.total) : 0;
    } catch (error) {
      throw new InternalError("Failed to count orders", error);
    }
  }

  async findById(scope: RowScope, id: string): Promise<OrderEntity | null> {
    let row;
    try {
      row = await db.query.orders.findFirst({
        where: and(eq(orders.id, id), this.rowScopeCondition(scope)),
        with: { designer: true, masterTailor: true, images: true },
      });
    } catch (error) {
      throw new InternalError("Failed to load order", error);
    }
    return row ? OrderMapper.toEntity(row) : null;
  }

  async getStats(scope: RowScope): Promise<OrderStatsRaw> {
    const condition = this.rowScopeCondition(scope);

    let orderRows;
    try {
      orderRows = await db
        .select({
          total: sql<string>`count(*)`,
          active: sql<string>`count(*) filter (where ${notInArray(orders.productionStatus, COMPLETED_STATUSES)})`,
          completed: sql<string>`count(*) filter (where ${inArray(orders.productionStatus, COMPLETED_STATUSES)})`,
          pendingPayments: sql<string>`count(*) filter (where ${ne(orders.paymentStatus, "fully_paid")})`,
          totalValue: sql<string>`coalesce(sum(${orders.totalAmount}), 0)`,
        })
        .from(orders)
        .where(condition);
    } catch (error) {
      throw new InternalError("Failed to load order stats", error);
    }

    let paymentRows;
    try {
      paymentRows = await db
        .select({ collected: sql<string>`coalesce(sum(${payments.amount}), 0)` })
        .from(payments)
        .innerJoin(orders, eq(orders.id, payments.orderId))
        .where(condition);
    } catch (error) {
      throw new InternalError("Failed to load order stats", error);
    }

    const row = orderRows[0];
    const collectedRevenue = Number(paymentRows[0]?.collected ?? 0);
    const totalValue = row ? Number(row.totalValue) : 0;

    return {
      total: row ? Number(row.total) : 0,
      active: row ? Number(row.active) : 0,
      completed: row ? Number(row.completed) : 0,
      pendingPayments: row ? Number(row.pendingPayments) : 0,
      collectedRevenue,
      outstandingRevenue: Math.max(totalValue - collectedRevenue, 0),
    };
  }

  private async findByIdUnscoped(id: string): Promise<OrderEntity | null> {
    const row = await db.query.orders.findFirst({
      where: eq(orders.id, id),
      with: { designer: true, masterTailor: true, images: true },
    });
    return row ? OrderMapper.toEntity(row) : null;
  }

  async findBasicById(id: string): Promise<OrderBasicInfo | null> {
    let rows;
    try {
      rows = await db
        .select({
          id: orders.id,
          designerId: orders.designerId,
          masterTailorId: orders.masterTailorId,
          totalAmount: orders.totalAmount,
          paymentStatus: orders.paymentStatus,
        })
        .from(orders)
        .where(eq(orders.id, id))
        .limit(1);
    } catch (error) {
      throw new InternalError("Failed to load order", error);
    }
    const row = rows[0];
    if (!row) return null;
    return { ...row, totalAmount: Number(row.totalAmount) };
  }

  async create(data: NewOrderRecord): Promise<OrderEntity> {
    let insertedId: string;
    try {
      insertedId = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(orders)
          .values({
            // orders_set_order_number (BEFORE INSERT trigger) unconditionally
            // overwrites this with the real ORD-{year}-{seq} value -- Drizzle
            // just needs *something* here since the column is NOT NULL.
            orderNumber: "",
            customerName: data.customerName,
            phone: data.phone,
            billNumber: data.billNumber,
            bookingDate: data.bookingDate,
            dueDate: data.dueDate,
            designerId: data.designerId,
            masterTailorId: data.masterTailorId,
            productCategory: data.productCategory,
            orderDetails: data.orderDetails,
            handWork: data.handWork,
            machineWork: data.machineWork,
            purchaseRequired: data.purchaseRequired,
            paymentStatus: data.paymentStatus,
            totalAmount: String(data.totalAmount),
            productionStatus: data.productionStatus,
            designerInstructions: data.designerInstructions,
            specialNotes: data.specialNotes,
            createdBy: data.createdBy,
            updatedBy: data.updatedBy,
          })
          .returning({ id: orders.id });
        if (!inserted) throw new InternalError("Failed to create order");

        // A brand-new order's history starts with one entry for its initial
        // status -- the timeline is never empty, same as every subsequent
        // status change (see updateStatus()).
        await tx.insert(orderStatusHistory).values({
          orderId: inserted.id,
          status: data.productionStatus,
          label: granularLabel(data.productionStatus),
          changedBy: data.createdBy,
        });

        return inserted.id;
      });
    } catch (error) {
      throw new InternalError("Failed to create order", error);
    }

    const entity = await this.findByIdUnscoped(insertedId);
    if (!entity) throw new InternalError("Failed to create order");
    return entity;
  }

  async update(id: string, data: UpdateOrderRecord): Promise<OrderEntity> {
    // updated_at is deliberately not touched: orders_set_updated_at (a
    // BEFORE UPDATE trigger) already keeps it current.
    const { totalAmount, ...rest } = data;
    const record: Partial<typeof orders.$inferInsert> = { ...rest };
    if (totalAmount !== undefined) record.totalAmount = String(totalAmount);

    try {
      await db.update(orders).set(record).where(eq(orders.id, id));
    } catch (error) {
      throw new InternalError("Failed to save order", error);
    }

    const entity = await this.findByIdUnscoped(id);
    if (!entity) throw new InternalError("Failed to save order");
    return entity;
  }

  async updateStatus(id: string, status: GranularStatus, changedBy: string): Promise<OrderEntity> {
    try {
      await db.transaction(async (tx) => {
        // updated_at is deliberately not touched here either -- same trigger as update().
        await tx.update(orders).set({ productionStatus: status, updatedBy: changedBy }).where(eq(orders.id, id));
        await tx.insert(orderStatusHistory).values({
          orderId: id,
          status,
          label: granularLabel(status),
          changedBy,
        });
      });
    } catch (error) {
      throw new InternalError("Failed to update order status", error);
    }

    const entity = await this.findByIdUnscoped(id);
    if (!entity) throw new InternalError("Failed to update order status");
    return entity;
  }

  async listStatusHistory(orderId: string): Promise<OrderStatusHistoryEntity[]> {
    let rows: OrderStatusHistoryRow[];
    try {
      rows = await db
        .select({
          id: orderStatusHistory.id,
          orderId: orderStatusHistory.orderId,
          status: orderStatusHistory.status,
          label: orderStatusHistory.label,
          changedBy: orderStatusHistory.changedBy,
          createdAt: orderStatusHistory.createdAt,
          changerFullName: profiles.fullName,
        })
        .from(orderStatusHistory)
        .leftJoin(profiles, eq(profiles.id, orderStatusHistory.changedBy))
        .where(eq(orderStatusHistory.orderId, orderId))
        .orderBy(desc(orderStatusHistory.createdAt));
    } catch (error) {
      throw new InternalError("Failed to load order status history", error);
    }
    return rows.map((row) => OrderStatusHistoryMapper.toEntity(row));
  }

  async upsertImage(data: NewImageRecord): Promise<void> {
    try {
      await db
        .insert(orderImages)
        .values({
          orderId: data.orderId,
          slot: data.slot,
          storagePath: data.storagePath,
          originalFilename: data.originalFilename,
          contentType: data.contentType,
          sizeBytes: data.sizeBytes,
          uploadedBy: data.uploadedBy,
        })
        .onConflictDoUpdate({
          target: [orderImages.orderId, orderImages.slot],
          set: {
            storagePath: data.storagePath,
            originalFilename: data.originalFilename,
            contentType: data.contentType,
            sizeBytes: data.sizeBytes,
            uploadedBy: data.uploadedBy,
          },
        });
    } catch (error) {
      throw new InternalError("Failed to save uploaded image", error);
    }
  }

  async findImage(orderId: string, slot: number): Promise<OrderImageInfo | null> {
    const rows = await db
      .select({ storagePath: orderImages.storagePath })
      .from(orderImages)
      .where(and(eq(orderImages.orderId, orderId), eq(orderImages.slot, slot)))
      .limit(1);
    return rows[0] ?? null;
  }

  async deleteImage(orderId: string, slot: number): Promise<void> {
    await db.delete(orderImages).where(and(eq(orderImages.orderId, orderId), eq(orderImages.slot, slot)));
  }

  async sumPaymentsForOrder(orderId: string): Promise<number> {
    let rows;
    try {
      rows = await db
        .select({ total: sql<string>`coalesce(sum(${payments.amount}), 0)` })
        .from(payments)
        .where(eq(payments.orderId, orderId));
    } catch (error) {
      throw new InternalError("Failed to sum payments", error);
    }
    return Number(rows[0]?.total ?? 0);
  }

  async sumPaymentsForOrders(orderIds: string[]): Promise<Record<string, number>> {
    if (orderIds.length === 0) return {};

    let rows;
    try {
      rows = await db
        .select({ orderId: payments.orderId, total: sql<string>`coalesce(sum(${payments.amount}), 0)` })
        .from(payments)
        .where(inArray(payments.orderId, orderIds))
        .groupBy(payments.orderId);
    } catch (error) {
      throw new InternalError("Failed to sum payments", error);
    }

    const sums: Record<string, number> = {};
    for (const row of rows) sums[row.orderId] = Number(row.total);
    return sums;
  }
}
