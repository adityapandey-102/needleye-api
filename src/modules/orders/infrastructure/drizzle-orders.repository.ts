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
import { ConflictError, InternalError, NotFoundError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import {
  CANONICAL_TO_GRANULAR,
  COMPLETED_CANONICAL_STAGES,
  PRODUCTION_STAGE_STATUSES,
  granularLabel,
  type GranularStatus,
} from "../../../domain";
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
  RevenuePeriod,
  StaffReportRaw,
  StaffWeeklyPoint,
  LedgerEventsResult,
} from "../application/ports/orders-repository.port";

/** The granular values a Kanban card sits on once it reaches the "ready"/"delivered" canonical columns -- see domain/order-status.ts. */
const COMPLETED_STATUSES = COMPLETED_CANONICAL_STAGES.map((stage) => CANONICAL_TO_GRANULAR[stage]);

/** Production stages still actively being worked (excludes ready/delivered) -- the "In Production" dashboard bucket. */
const IN_PRODUCTION_STATUSES = PRODUCTION_STAGE_STATUSES.filter((s) => !COMPLETED_STATUSES.includes(s));

/** SQL-safe `'a','b'` lists of the status groups, for raw queries (values are code constants, never user input). */
const COMPLETED_STATUS_SQL_LIST = COMPLETED_STATUSES.map((s) => `'${s}'`).join(", ");
const IN_PRODUCTION_STATUS_SQL_LIST = IN_PRODUCTION_STATUSES.map((s) => `'${s}'`).join(", ");

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
    conditions.push(this.bucketCondition(filters.bucket));

    return and(...conditions);
  }

  /** Translates a dashboard "bucket" (the filter a summary card links to) into a WHERE condition. */
  private bucketCondition(bucket: string | undefined) {
    switch (bucket) {
      case "active":
        return notInArray(orders.productionStatus, COMPLETED_STATUSES);
      case "production":
        return inArray(orders.productionStatus, IN_PRODUCTION_STATUSES);
      case "completed":
        return inArray(orders.productionStatus, COMPLETED_STATUSES);
      case "ready":
        return eq(orders.productionStatus, "ready_for_delivery");
      case "delivered":
        return eq(orders.productionStatus, "delivered");
      case "pending_payment":
        return ne(orders.paymentStatus, "fully_paid");
      case "payment_overdue":
        // Outstanding balance whose scheduled next-payment date has passed.
        return and(ne(orders.paymentStatus, "fully_paid"), sql`${orders.nextPaymentDate} < current_date`);
      case "payment_upcoming":
        // Outstanding balance with a next-payment date still ahead (or today).
        return and(ne(orders.paymentStatus, "fully_paid"), sql`${orders.nextPaymentDate} >= current_date`);
      case "overdue":
        return and(notInArray(orders.productionStatus, COMPLETED_STATUSES), sql`${orders.dueDate} < current_date`);
      case "urgent":
        return and(
          notInArray(orders.productionStatus, COMPLETED_STATUSES),
          sql`${orders.dueDate} >= current_date and ${orders.dueDate} < current_date + 3`,
        );
      case "this_month":
        return sql`${orders.createdAt} >= date_trunc('month', current_date)`;
      default:
        return undefined;
    }
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
          thisMonth: sql<string>`count(*) filter (where ${orders.createdAt} >= date_trunc('month', current_date))`,
          inProduction: sql<string>`count(*) filter (where ${inArray(orders.productionStatus, IN_PRODUCTION_STATUSES)})`,
          // Delivery-timeline urgency, on active (not-yet-completed) orders only --
          // mirrors the frontend's getTimelineSummary thresholds (overdue: past due;
          // urgent: due within 3 days).
          overdue: sql<string>`count(*) filter (where ${notInArray(orders.productionStatus, COMPLETED_STATUSES)} and ${orders.dueDate} < current_date)`,
          urgent: sql<string>`count(*) filter (where ${notInArray(orders.productionStatus, COMPLETED_STATUSES)} and ${orders.dueDate} >= current_date and ${orders.dueDate} < current_date + 3)`,
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
      thisMonth: row ? Number(row.thisMonth) : 0,
      inProduction: row ? Number(row.inProduction) : 0,
      overdue: row ? Number(row.overdue) : 0,
      urgent: row ? Number(row.urgent) : 0,
      pendingPayments: row ? Number(row.pendingPayments) : 0,
      collectedRevenue,
      outstandingRevenue: Math.max(totalValue - collectedRevenue, 0),
    };
  }

  async getMonthlyRevenue(scope: RowScope, cycleStartDay: number, range: { from: string; to: string }): Promise<RevenuePeriod[]> {
    // Accounting period of a payment: shift paid_at back by (startDay-1) days,
    // truncate to the month, then shift forward again -- so startDay=1 is the
    // calendar month and startDay=7 runs 7th -> next 7th. Grouped + ordered by
    // that computed period start (select position 1), oldest first.
    const shift = sql`make_interval(days => ${cycleStartDay - 1})`;
    const periodStart = sql<string>`(date_trunc('month', ${payments.paidAt} - ${shift}) + ${shift})::date`;

    // Row scope (unscoped for the financial roles this endpoint is gated to) +
    // the requested inclusive date window on paid_at.
    const condition = and(
      this.rowScopeCondition(scope),
      sql`${payments.paidAt} >= ${range.from}`,
      sql`${payments.paidAt} <= ${range.to}`,
    );

    let rows;
    try {
      rows = await db
        .select({
          periodStart,
          collected: sql<string>`coalesce(sum(${payments.amount}), 0)`,
          paymentCount: sql<string>`count(*)`,
        })
        .from(payments)
        .innerJoin(orders, eq(orders.id, payments.orderId))
        .where(condition)
        .groupBy(sql`1`)
        .orderBy(sql`1 asc`);
    } catch (error) {
      throw new InternalError("Failed to load revenue report", error);
    }

    return rows.map((r) => ({
      periodStart: r.periodStart,
      collected: Number(r.collected),
      paymentCount: Number(r.paymentCount),
    }));
  }

  async getStaffReport(staffId: string, range: { from: string; to: string }): Promise<StaffReportRaw | null> {
    // 1. Resolve the person -- must be an ACTIVE designer/master_tailor.
    let staff;
    try {
      const rows = await db
        .select({ id: profiles.id, fullName: profiles.fullName, role: profiles.role, active: profiles.active })
        .from(profiles)
        .where(eq(profiles.id, staffId))
        .limit(1);
      staff = rows[0];
    } catch (error) {
      throw new InternalError("Failed to load staff member", error);
    }
    if (!staff || !staff.active || (staff.role !== "designer" && staff.role !== "master_tailor")) return null;

    // Which order column links this person to an order. The value is derived
    // from the DB (one of two fixed strings), never user input -- safe to inline.
    const staffColumnName = staff.role === "designer" ? "designer_id" : "master_tailor_id";

    // 2. The month's COHORT board: every metric is over the orders this person
    //    booked in [from, to], showing where that cohort stands now (same
    //    COUNT(*) FILTER pattern as the dashboard). Written as a raw
    //    parameterized query -- the outstanding-amount correlated ledger
    //    subquery must run against the orders table directly, which the query
    //    builder's sql-template interpolation didn't correlate reliably.
    //    staffId + range are parameterized; the column name + status lists are
    //    code constants (never user input). payments_order_idx keeps each
    //    per-order ledger lookup cheap.
    type SummaryRow = {
      booked: number; active: number; in_production: number; completed: number;
      overdue: number; urgent: number; pp_count: number; pp_amount: string;
    };
    let summary: SummaryRow;
    try {
      const res = await db.execute<SummaryRow>(sql`
        select
          count(*)::int as booked,
          count(*) filter (where production_status not in (${sql.raw(COMPLETED_STATUS_SQL_LIST)}))::int as active,
          count(*) filter (where production_status in (${sql.raw(IN_PRODUCTION_STATUS_SQL_LIST)}))::int as in_production,
          count(*) filter (where production_status in (${sql.raw(COMPLETED_STATUS_SQL_LIST)}))::int as completed,
          count(*) filter (where production_status not in (${sql.raw(COMPLETED_STATUS_SQL_LIST)}) and due_date < current_date)::int as overdue,
          count(*) filter (where production_status not in (${sql.raw(COMPLETED_STATUS_SQL_LIST)}) and due_date >= current_date and due_date < current_date + 3)::int as urgent,
          count(*) filter (where payment_status <> 'fully_paid')::int as pp_count,
          coalesce(sum(greatest(total_amount - coalesce((select sum(p.amount) from payments p where p.order_id = orders.id), 0), 0)) filter (where payment_status <> 'fully_paid'), 0) as pp_amount
        from orders
        where orders.${sql.raw(staffColumnName)} = ${staffId}
          and booking_date >= ${range.from}::date
          and booking_date <= ${range.to}::date
      `);
      summary = (res.rows ?? (res as unknown as SummaryRow[]))[0]!;
    } catch (error) {
      throw new InternalError("Failed to load staff report summary", error);
    }

    // 3. Weekly throughput for the month window, zero-filled and continuous.
    //    generate_series builds every Monday from the week of `from` to the week
    //    of `to`; two correlated subqueries count orders booked (created_at) and
    //    completed (earliest ready/delivered history event) in that week. One
    //    query, ~4-6 rows out (a month's weeks).
    let weekly: StaffWeeklyPoint[];
    try {
      const res = await db.execute<{ week_start: string; booked: number; completed: number }>(sql`
        select
          to_char(w.week_start, 'YYYY-MM-DD') as week_start,
          (select count(*)::int from orders o2
             where o2.${sql.raw(staffColumnName)} = ${staffId}
               and date_trunc('week', o2.booking_date) = w.week_start) as booked,
          (select count(*)::int from (
             select h.order_id, min(h.created_at) as done_at
             from order_status_history h
             join orders o3 on o3.id = h.order_id
             where o3.${sql.raw(staffColumnName)} = ${staffId}
               and h.status in (${sql.raw(COMPLETED_STATUS_SQL_LIST)})
             group by h.order_id
           ) c where date_trunc('week', c.done_at) = w.week_start) as completed
        from generate_series(
          date_trunc('week', ${range.from}::date),
          date_trunc('week', ${range.to}::date),
          interval '1 week'
        ) as w(week_start)
        order by w.week_start asc
      `);
      const rows = (res.rows ?? (res as unknown as { week_start: string; booked: number; completed: number }[]));
      weekly = rows.map((r) => ({ weekStart: r.week_start, booked: Number(r.booked), completed: Number(r.completed) }));
    } catch (error) {
      throw new InternalError("Failed to load staff weekly throughput", error);
    }

    return {
      staff: { id: staff.id, fullName: staff.fullName, role: staff.role },
      summary: {
        booked: Number(summary.booked),
        active: Number(summary.active),
        inProduction: Number(summary.in_production),
        completed: Number(summary.completed),
        overdue: Number(summary.overdue),
        urgent: Number(summary.urgent),
        paymentPendingCount: Number(summary.pp_count),
        paymentPendingAmount: Number(summary.pp_amount),
      },
      weekly,
    };
  }

  /**
   * Paginated payment-ledger audit trail: every payment.created/updated/deleted
   * event in [from, to] (whole-day inclusive), newest first, joined to the
   * actor (profiles) and the affected order. `orderId` is pulled out of the
   * append-only audit metadata; the order join is a LEFT join so an event
   * survives even if its order was later removed.
   */
  async getLedgerEvents(range: { from: string; to: string }, page: OrderListPage): Promise<LedgerEventsResult> {
    let events: LedgerEventsResult["events"];
    let total: number;
    try {
      const rows = await db.execute(sql`
        select
          a.id::text as id,
          a.action,
          to_char(a.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at,
          pr.full_name as actor_name,
          (a.metadata->>'orderId') as order_id,
          o.order_number as order_number,
          a.metadata as metadata
        from audit_log a
        left join profiles pr on pr.id = a.actor_id
        left join orders o on o.id = nullif(a.metadata->>'orderId', '')::uuid
        where a.entity_type = 'payment'
          and a.created_at >= ${range.from}::date
          and a.created_at < (${range.to}::date + 1)
        order by a.created_at desc
        limit ${page.limit} offset ${page.offset}
      `);
      const list = (rows.rows ?? (rows as unknown as Record<string, unknown>[])) as {
        id: string;
        action: string;
        created_at: string;
        actor_name: string | null;
        order_id: string | null;
        order_number: string | null;
        metadata: Record<string, unknown> | null;
      }[];
      events = list.map((r) => ({
        id: r.id,
        action: r.action,
        createdAt: r.created_at,
        actorName: r.actor_name,
        orderId: r.order_id,
        orderNumber: r.order_number,
        metadata: r.metadata,
      }));

      const countRes = await db.execute(sql`
        select count(*)::int as total
        from audit_log a
        where a.entity_type = 'payment'
          and a.created_at >= ${range.from}::date
          and a.created_at < (${range.to}::date + 1)
      `);
      const countRows = (countRes.rows ?? (countRes as unknown as { total: number }[])) as { total: number }[];
      total = Number(countRows[0]?.total ?? 0);
    } catch (error) {
      throw new InternalError("Failed to load ledger events", error);
    }

    return { events, total };
  }

  private async findByIdUnscoped(id: string): Promise<OrderEntity | null> {
    const row = await db.query.orders.findFirst({
      where: eq(orders.id, id),
      with: { designer: true, masterTailor: true, images: true },
    });
    return row ? OrderMapper.toEntity(row) : null;
  }

  /** Public, row-scope-ignoring lookup for the view-only path (see the port). */
  findAnyById(id: string): Promise<OrderEntity | null> {
    return this.findByIdUnscoped(id);
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
            nextPaymentDate: data.nextPaymentDate,
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

  async update(id: string, data: UpdateOrderRecord, expectedVersion?: number): Promise<OrderEntity> {
    // updated_at is deliberately not touched: orders_set_updated_at (a
    // BEFORE UPDATE trigger) already keeps it current. `version` is always
    // bumped so the next reader/editor sees a moved-on value (optimistic lock).
    const { totalAmount, ...rest } = data;
    const record: Partial<typeof orders.$inferInsert> = { ...rest };
    if (totalAmount !== undefined) record.totalAmount = String(totalAmount);

    // When a version is supplied, the write only lands if the stored version
    // still matches -- so a concurrent edit (holding the old version) hits 0 rows.
    const where =
      expectedVersion !== undefined ? and(eq(orders.id, id), eq(orders.version, expectedVersion)) : eq(orders.id, id);

    let updated: { id: string }[];
    try {
      updated = await db
        .update(orders)
        .set({ ...record, version: sql`${orders.version} + 1` })
        .where(where)
        .returning({ id: orders.id });
    } catch (error) {
      throw new InternalError("Failed to save order", error);
    }

    if (updated.length === 0) {
      // Nothing matched. With a version guard, disambiguate "gone" from
      // "changed under me" so the client can show the right message.
      if (expectedVersion !== undefined && (await this.findByIdUnscoped(id))) {
        throw new ConflictError("This order was changed by someone else. Reload and try again.", ERROR_CODES.ORDER_MODIFIED);
      }
      throw new NotFoundError("Order not found", ERROR_CODES.ORDER_NOT_FOUND);
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
