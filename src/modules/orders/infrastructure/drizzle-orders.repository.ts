import { and, desc, eq, gte, ilike, inArray, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { db } from "../../../common/database/drizzle-client";
import { orders } from "./order.schema";
import { orderImages } from "./order-image.schema";
import { orderStatusHistory } from "./order-status-history.schema";
import { orderPriceHistory } from "./order-price-history.schema";
import { orderAuditLog } from "./order-audit-log.schema";
// Cross-module Infrastructure-only read of Payments' log, for the Ledger
// Activity feed -- see docs/adr/0003-per-module-schema-ownership.md.
import { paymentAuditLog } from "../../payments/infrastructure/payment-audit-log.schema";
import { getRequestContext } from "../../../common/context/request-context";
// Cross-module Infrastructure-only read of Payments' schema, for the ledger
// sum aggregates below -- see docs/adr/0003-per-module-schema-ownership.md.
import { payments } from "../../payments/infrastructure/payments.schema";
// Cross-module Infrastructure-only read: `profiles` is owned by the Users
// module's schema. See docs/adr/0003-per-module-schema-ownership.md.
import { profiles } from "../../users/infrastructure/profile.schema";
import { AppError, ConflictError, InternalError, NotFoundError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { outstanding, toMoneyString } from "../../../common/money/money";
import { containsPattern } from "../../../common/database/like-pattern";
import {
  CANONICAL_TO_GRANULAR,
  COMPLETED_CANONICAL_STAGES,
  PIPELINE_STAGE_GROUPS,
  PRODUCTION_STAGE_STATUSES,
  READY_STATUS,
  granularLabel,
  type GranularStatus,
} from "../../../domain";
import { assertStageMove } from "../domain/order-status.rules";
import { assertBookingMonthOpen, assertPricedForDelivery, type PriceChangeDecision, type PriceState } from "../domain/order-pricing.rules";
import { LEDGER_MONTH_LOCK_NAMESPACE } from "../../../common/database/ledger-month-lock";
import { derivePaymentStatus } from "../domain/order-ledger.rules";
import type { OrderPriceChangeEntity } from "../domain/order-price-change.entity";
import { diffOrderFields, PERSON_FIELDS, type OrderAuditAction, type OrderFieldChanges } from "../domain/order-audit.rules";
import { OrderMapper, type OrderQueryResult } from "./order.mapper";
import { OrderStatusHistoryMapper, type OrderStatusHistoryRow } from "./order-status-history.mapper";
import type { OrderEntity } from "../domain/order.entity";
import type { OrderStatusHistoryEntity } from "../domain/order-status-history.entity";
import { env } from "../../../config/env";
import { businessToday, monthStartMonthsBack } from "../../../common/time/business-date";
import type {
  OrdersRepositoryPort,
  RowScope,
  OrderListFilters,
  OrderListPage,
  NewOrderRecord,
  UpdateOrderRecord,
  NewImageRecord,
  OrderBasicInfo,
  CustomerMatch,
  OrderImageInfo,
  OrderStatsRaw,
  StaffReportRaw,
  StaffWeeklyPoint,
  LedgerEventsResult,
  DueDateCapacityGuard,
  LeadLink,
} from "../application/ports/orders-repository.port";
import { convertLeadInTransaction } from "../../leads/infrastructure/lead-conversion";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Takes each booking month's SHARED lock (the one a close holds exclusively)
 * and refuses if its books are closed (owner, 2026-10-09): no booking into or
 * out of a closed month, no price change on an order booked in one. The
 * database guard (orders_closed_month_guard) takes the same lock and re-checks.
 */
async function bookingMonthsOpen(tx: Tx, action: "price" | "booking", ...days: (string | null | undefined)[]): Promise<void> {
  const months = [...new Set(days.filter((d): d is string => Boolean(d)).map((d) => d.slice(0, 7)))].sort();
  for (const month of months) {
    const day = `${month}-01`;
    await tx.execute(sql`select pg_advisory_xact_lock_shared(${LEDGER_MONTH_LOCK_NAMESPACE}::int, public.ledger_month_key(${day}::date))`);
    // A separate statement, so it sees a close that committed while we waited for the lock.
    const res = await tx.execute<{ closed: boolean }>(sql`select public.ledger_month_closed(${day}::date) as closed`);
    assertBookingMonthOpen(month, res.rows[0]?.closed === true, action);
  }
}

/**
 * Namespace for the per-date advisory lock (first key of the two-int form), so
 * it can never collide with any other advisory lock this app might take later.
 */
export const DELIVERY_DAY_LOCK_NAMESPACE = 4201;

/**
 * Serialises every create/edit that lands on `dueDate` for the rest of the
 * transaction, then counts the orders already there (optionally leaving one
 * out). Without the lock, two people booking a day's last slot at the same
 * moment would both read "9 of 10" and both succeed -> 11. A transaction-scoped
 * advisory lock is released automatically at commit/rollback.
 */
async function lockDayAndCount(tx: Tx, dueDate: string, excludeOrderId?: string): Promise<number> {
  await tx.execute(sql`select pg_advisory_xact_lock(${DELIVERY_DAY_LOCK_NAMESPACE}::int, hashtext(${dueDate}::text))`);
  const [row] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .where(excludeOrderId ? and(eq(orders.dueDate, dueDate), ne(orders.id, excludeOrderId)) : eq(orders.dueDate, dueDate));
  return row?.n ?? 0;
}

/** The granular values a Kanban card sits on once it reaches the "ready"/"delivered" canonical columns -- see domain/order-status.ts. */
const COMPLETED_STATUSES = COMPLETED_CANONICAL_STAGES.map((stage) => CANONICAL_TO_GRANULAR[stage]);

/** Production stages still actively being worked (excludes Ready and Delivered) -- the "In Production" dashboard bucket. */
const IN_PRODUCTION_STATUSES = PRODUCTION_STAGE_STATUSES.filter((s) => !COMPLETED_STATUSES.includes(s) && s !== READY_STATUS);

/** Payment statuses that still have money to collect -- a "not_priced" order owes nothing YET (ADR 0008). */
const OWED_PAYMENT_STATUSES = ["unpaid", "advance_paid"] as const;

/** SQL-safe `'a','b'` lists of the status groups, for raw queries (values are code constants, never user input). */
const COMPLETED_STATUS_SQL_LIST = COMPLETED_STATUSES.map((s) => `'${s}'`).join(", ");
const IN_PRODUCTION_STATUS_SQL_LIST = IN_PRODUCTION_STATUSES.map((s) => `'${s}'`).join(", ");

/** Appends one order_audit_log row inside the caller's transaction (ADR 0008). */
async function logOrder(
  tx: Tx,
  entry: { orderId: string; action: OrderAuditAction; actorId: string; changes?: OrderFieldChanges | null; details?: Record<string, unknown> | null },
): Promise<void> {
  await tx.insert(orderAuditLog).values({
    orderId: entry.orderId,
    action: entry.action,
    changes: entry.changes ?? null,
    details: entry.details && Object.keys(entry.details).length > 0 ? entry.details : null,
    actorId: entry.actorId,
    requestId: getRequestContext()?.requestId ?? null,
  });
}

/** A designer / master tailor change is logged with both people's names (an id alone means nothing in a report). */
async function labelPeople(tx: Tx, changes: OrderFieldChanges): Promise<void> {
  const ids = PERSON_FIELDS.flatMap((field) => {
    const change = changes[field];
    return change ? [change.from, change.to].filter((v): v is string => typeof v === "string") : [];
  });
  if (ids.length === 0) return;
  const people = await tx.select({ id: profiles.id, fullName: profiles.fullName }).from(profiles).where(inArray(profiles.id, ids));
  const nameOf = (value: unknown) => people.find((p) => p.id === value)?.fullName ?? null;
  for (const field of PERSON_FIELDS) {
    const change = changes[field];
    if (change) changes[field] = { ...change, fromLabel: nameOf(change.from), toLabel: nameOf(change.to) };
  }
}

/**
 * Midnight on the 1st of the current month in the SHOP's timezone, as an
 * instant -- a plain range bound, so timestamp indexes apply. The date is
 * computed here and sent as a value (not derived from now() in SQL): with a
 * concrete bound the planner can estimate how few rows match, where a now()
 * expression made it guess "a third of the table" and scan every order.
 */
/** The shop's today (YYYY-MM-DD in BUSINESS_TIMEZONE), as a bound value -- "today" for due dates. */
function shopToday(): string {
  return businessToday(new Date(), env.BUSINESS_TIMEZONE);
}

function shopMonthStart() {
  const monthStart = monthStartMonthsBack(businessToday(new Date(), env.BUSINESS_TIMEZONE), 0);
  return sql`((${monthStart}::date)::timestamp at time zone ${env.BUSINESS_TIMEZONE})`;
}

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
      const term = containsPattern(filters.search.trim());
      conditions.push(or(ilike(orders.customerName, term), ilike(orders.billNumber, term), ilike(orders.orderNumber, term)));
    }
    if (filters.status) conditions.push(eq(orders.productionStatus, filters.status as OrderEntity["productionStatus"]));
    if (filters.designerId) conditions.push(eq(orders.designerId, filters.designerId));
    if (filters.masterTailorId) conditions.push(eq(orders.masterTailorId, filters.masterTailorId));
    conditions.push(this.bucketCondition(filters.bucket));
    // One delivery day's orders (orders_due_date_idx).
    if (filters.dueOn) conditions.push(eq(orders.dueDate, filters.dueOn));
    conditions.push(this.timelineCondition(filters.timeline));
    // Booking year / month: a plain range on booking_date (orders_booking_date_idx).
    if (filters.bookedYear) {
      const y = filters.bookedYear;
      const m = filters.bookedMonth;
      const from = m ? `${y}-${String(m).padStart(2, "0")}-01` : `${y}-01-01`;
      const to = m ? (m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`) : `${y + 1}-01-01`;
      conditions.push(sql`${orders.bookingDate} >= ${from}::date and ${orders.bookingDate} < ${to}::date`);
    }
    if (filters.createdFrom) {
      // Midnight of that day in the SHOP's timezone, as an instant -- a plain
      // range on created_at, so orders_created_at_idx applies.
      conditions.push(
        sql`${orders.createdAt} >= ((${filters.createdFrom}::date)::timestamp at time zone ${env.BUSINESS_TIMEZONE})`,
      );
    }

    return and(...conditions);
  }

  /** The timeline pill's states (web: getTimelineSummary), as a WHERE condition on the due date. */
  private timelineCondition(timeline: OrderListFilters["timeline"]) {
    const open = ne(orders.productionStatus, "delivered");
    switch (timeline) {
      case "delivered":
        return eq(orders.productionStatus, "delivered");
      case "overdue":
        return and(open, sql`${orders.dueDate} < current_date`);
      case "urgent":
        return and(open, sql`${orders.dueDate} >= current_date and ${orders.dueDate} < current_date + 3`);
      case "due_soon":
        return and(open, sql`${orders.dueDate} >= current_date + 3 and ${orders.dueDate} <= current_date + 7`);
      case "on_track":
        return and(open, sql`${orders.dueDate} > current_date + 7`);
      default:
        return undefined;
    }
  }

  async findCustomersByPhone(phone: string, limit: number): Promise<CustomerMatch[]> {
    try {
      // orders_phone_created_idx: the newest few for one phone.
      const rows = await db
        .select({ orderId: orders.id, orderNumber: orders.orderNumber, customerName: orders.customerName, bookingDate: orders.bookingDate })
        .from(orders)
        .where(eq(orders.phone, phone))
        .orderBy(desc(orders.createdAt))
        .limit(limit);
      return rows;
    } catch (error) {
      throw new InternalError("Failed to look up the customer", error);
    }
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
      case "delivered":
        return eq(orders.productionStatus, "delivered");
      case "ready":
        return eq(orders.productionStatus, READY_STATUS);
      // The dashboard pipeline's steps -- exactly the stages each step counts in getStats.
      case "pipeline_design":
        return inArray(orders.productionStatus, PIPELINE_STAGE_GROUPS.design);
      case "pipeline_received":
        return inArray(orders.productionStatus, PIPELINE_STAGE_GROUPS.received);
      case "pipeline_production":
        return inArray(orders.productionStatus, PIPELINE_STAGE_GROUPS.production);
      case "pipeline_checks":
        return inArray(orders.productionStatus, PIPELINE_STAGE_GROUPS.checks);
      case "delivered_this_month":
        // Same definition as getStats' deliveredThisMonth card. "= any(array(...))"
        // runs the subquery FIRST (a short range read of this month's delivery
        // events on order_status_history_completed_idx), then fetches just those
        // orders by primary key. As a join or EXISTS the planner preferred to
        // scan every delivered order (the query audit flagged it).
        return and(
          eq(orders.productionStatus, "delivered"),
          sql`${orders.id} = any(array(select h.order_id from ${orderStatusHistory} h where h.status = 'delivered' and h.created_at >= ${shopMonthStart()}))`,
        );
      case "pending_payment":
        return inArray(orders.paymentStatus, [...OWED_PAYMENT_STATUSES]);
      case "not_priced":
        return eq(orders.paymentStatus, "not_priced");
      // Payment due dates against the SHOP's today (not the database's UTC day).
      case "payment_overdue":
        // Outstanding balance whose scheduled next-payment date has passed.
        return and(inArray(orders.paymentStatus, [...OWED_PAYMENT_STATUSES]), sql`${orders.nextPaymentDate} < ${shopToday()}::date`);
      case "payment_due_today":
        // Outstanding balance whose next payment is due today -- to collect today.
        return and(inArray(orders.paymentStatus, [...OWED_PAYMENT_STATUSES]), sql`${orders.nextPaymentDate} = ${shopToday()}::date`);
      case "payment_upcoming":
        // Outstanding balance with a next-payment date after today.
        return and(inArray(orders.paymentStatus, [...OWED_PAYMENT_STATUSES]), sql`${orders.nextPaymentDate} > ${shopToday()}::date`);
      case "booked_today":
        // Booked today, by booking date (orders_booking_date_idx).
        return sql`${orders.bookingDate} = ${shopToday()}::date`;
      case "due_today":
        // To deliver today: not delivered yet, due today (orders_due_date_idx).
        return and(ne(orders.productionStatus, "delivered"), sql`${orders.dueDate} = ${shopToday()}::date`);
      case "overdue":
        return and(notInArray(orders.productionStatus, COMPLETED_STATUSES), sql`${orders.dueDate} < current_date`);
      case "urgent":
        return and(
          notInArray(orders.productionStatus, COMPLETED_STATUSES),
          sql`${orders.dueDate} >= current_date and ${orders.dueDate} < current_date + 3`,
        );
      case "this_month":
        return sql`${orders.createdAt} >= ${shopMonthStart()}`;
      default:
        return undefined;
    }
  }

  async findMany(scope: RowScope, filters: OrderListFilters, page: OrderListPage): Promise<OrderEntity[]> {
    try {
      // One round trip for every order plus its designer/masterTailor -- not
      // N+1 -- via Drizzle's relational query API (see order.relations.ts).
      // Images are deliberately NOT loaded: no list screen shows them, and each
      // one would also need a signed URL from storage. Entities come back with
      // images: [] -- a single order (findById) still loads them.
      // limit/offset keep this bounded regardless of total order count.
      const rows = await db.query.orders.findMany({
        where: this.listConditions(scope, filters),
        orderBy: [desc(orders.createdAt)],
        with: { designer: true, masterTailor: true },
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
          ready: sql<string>`count(*) filter (where ${eq(orders.productionStatus, READY_STATUS)})`,
          thisMonth: sql<string>`count(*) filter (where ${orders.createdAt} >= ${shopMonthStart()})`,
          inProduction: sql<string>`count(*) filter (where ${inArray(orders.productionStatus, IN_PRODUCTION_STATUSES)})`,
          // Delivery-timeline urgency, on active (not-yet-completed) orders only --
          // mirrors the frontend's getTimelineSummary thresholds (overdue: past due;
          // urgent: due within 3 days).
          overdue: sql<string>`count(*) filter (where ${notInArray(orders.productionStatus, COMPLETED_STATUSES)} and ${orders.dueDate} < current_date)`,
          urgent: sql<string>`count(*) filter (where ${notInArray(orders.productionStatus, COMPLETED_STATUSES)} and ${orders.dueDate} >= current_date and ${orders.dueDate} < current_date + 3)`,
          pendingPayments: sql<string>`count(*) filter (where ${inArray(orders.paymentStatus, [...OWED_PAYMENT_STATUSES])})`,
          // Today (the shop's day): orders to deliver, and payments to collect / already late.
          bookedToday: sql<string>`count(*) filter (where ${orders.bookingDate} = ${shopToday()}::date)`,
          dueToday: sql<string>`count(*) filter (where ${ne(orders.productionStatus, "delivered")} and ${orders.dueDate} = ${shopToday()}::date)`,
          paymentDueToday: sql<string>`count(*) filter (where ${inArray(orders.paymentStatus, [...OWED_PAYMENT_STATUSES])} and ${orders.nextPaymentDate} = ${shopToday()}::date)`,
          paymentOverdue: sql<string>`count(*) filter (where ${inArray(orders.paymentStatus, [...OWED_PAYMENT_STATUSES])} and ${orders.nextPaymentDate} < ${shopToday()}::date)`,
          notPriced: sql<string>`count(*) filter (where ${eq(orders.paymentStatus, "not_priced")})`,
          totalValue: sql<string>`coalesce(sum(${orders.totalAmount}), 0)`,
          // The pipeline (ADR 0008 dashboard): four more counts in the same pass (ready is above).
          pipelineDesign: sql<string>`count(*) filter (where ${inArray(orders.productionStatus, PIPELINE_STAGE_GROUPS.design)})`,
          pipelineReceived: sql<string>`count(*) filter (where ${inArray(orders.productionStatus, PIPELINE_STAGE_GROUPS.received)})`,
          pipelineProduction: sql<string>`count(*) filter (where ${inArray(orders.productionStatus, PIPELINE_STAGE_GROUPS.production)})`,
          pipelineChecks: sql<string>`count(*) filter (where ${inArray(orders.productionStatus, PIPELINE_STAGE_GROUPS.checks)})`,
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

    // Delivered THIS month, by the delivery's stage-history row (one short
    // range read on order_status_history_completed_idx). Distinct orders: old
    // data remapped from the retired ready_for_delivery stage can carry two
    // delivered rows for one order.
    // Unscoped callers don't need orders at all; a scoped one joins its own rows.
    let deliveredRows;
    try {
      const deliveredThisMonth = and(eq(orderStatusHistory.status, "delivered"), gte(orderStatusHistory.createdAt, shopMonthStart()));
      const count = db.select({ n: sql<string>`count(distinct ${orderStatusHistory.orderId})` }).from(orderStatusHistory);
      deliveredRows = condition
        ? await count.innerJoin(orders, eq(orders.id, orderStatusHistory.orderId)).where(and(deliveredThisMonth, condition))
        : await count.where(deliveredThisMonth);
    } catch (error) {
      throw new InternalError("Failed to load order stats", error);
    }

    const row = orderRows[0];
    const collectedRevenue = paymentRows[0]?.collected ?? "0";
    const totalValue = row?.totalValue ?? "0";

    return {
      total: row ? Number(row.total) : 0,
      active: row ? Number(row.active) : 0,
      completed: row ? Number(row.completed) : 0,
      deliveredThisMonth: Number(deliveredRows[0]?.n ?? 0),
      ready: row ? Number(row.ready) : 0,
      thisMonth: row ? Number(row.thisMonth) : 0,
      inProduction: row ? Number(row.inProduction) : 0,
      overdue: row ? Number(row.overdue) : 0,
      urgent: row ? Number(row.urgent) : 0,
      pendingPayments: row ? Number(row.pendingPayments) : 0,
      notPriced: row ? Number(row.notPriced) : 0,
      bookedToday: row ? Number(row.bookedToday) : 0,
      dueToday: row ? Number(row.dueToday) : 0,
      paymentDueToday: row ? Number(row.paymentDueToday) : 0,
      paymentOverdue: row ? Number(row.paymentOverdue) : 0,
      collectedRevenue: toMoneyString(collectedRevenue),
      outstandingRevenue: toMoneyString(outstanding(totalValue, collectedRevenue)),
      pipeline: {
        design: row ? Number(row.pipelineDesign) : 0,
        received: row ? Number(row.pipelineReceived) : 0,
        production: row ? Number(row.pipelineProduction) : 0,
        checks: row ? Number(row.pipelineChecks) : 0,
        ready: row ? Number(row.ready) : 0,
      },
    };
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
          count(*) filter (where payment_status in ('unpaid', 'advance_paid'))::int as pp_count,
          coalesce(sum(greatest(total_amount - coalesce((select sum(p.amount) from payments p where p.order_id = orders.id), 0), 0)) filter (where payment_status in ('unpaid', 'advance_paid')), 0) as pp_amount
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
    //    of `to`. Orders booked and orders completed (earliest ready/delivered
    //    history event) are each counted in ONE grouped pass over this
    //    person's orders, then joined onto the weeks -- not one correlated
    //    subquery per week (which re-read their whole history once per week).
    //    ~4-6 rows out (a month's weeks).
    let weekly: StaffWeeklyPoint[];
    try {
      const res = await db.execute<{ week_start: string; booked: number; completed: number }>(sql`
        with weeks as (
          select w.week_start
          from generate_series(
            date_trunc('week', ${range.from}::date),
            date_trunc('week', ${range.to}::date),
            interval '1 week'
          ) as w(week_start)
        ),
        bounds as (select min(week_start) as lo, max(week_start) + interval '1 week' as hi from weeks),
        booked as (
          select date_trunc('week', o.booking_date) as week_start, count(*)::int as n
          from orders o, bounds b
          where o.${sql.raw(staffColumnName)} = ${staffId}
            and o.booking_date >= b.lo and o.booking_date < b.hi
          group by 1
        ),
        -- An order counts in the week of its FIRST completion: take the
        -- completion events inside the window (partial index
        -- order_status_history_completed_idx), keep this person's orders, and
        -- drop any event that has an earlier completion for the same order.
        completed as (
          select date_trunc('week', h.created_at) as week_start, count(*)::int as n
          from bounds b
          join order_status_history h
            on h.status in (${sql.raw(COMPLETED_STATUS_SQL_LIST)})
           and h.created_at >= b.lo and h.created_at < b.hi
          join orders o on o.id = h.order_id
          where o.${sql.raw(staffColumnName)} = ${staffId}
            and not exists (
              select 1 from order_status_history e
              where e.order_id = h.order_id
                and e.status in (${sql.raw(COMPLETED_STATUS_SQL_LIST)})
                and e.created_at < h.created_at
            )
          group by 1
        )
        select
          to_char(w.week_start, 'YYYY-MM-DD') as week_start,
          coalesce(bk.n, 0) as booked,
          coalesce(cp.n, 0) as completed
        from weeks w
        left join booked bk on bk.week_start = w.week_start
        left join completed cp on cp.week_start = w.week_start
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
        paymentPendingAmount: toMoneyString(summary.pp_amount),
      },
      weekly,
    };
  }

  /**
   * Paginated payment-ledger audit trail: every payment.created/updated/deleted
   * event in [from, to] (whole-day inclusive), newest first, joined to the
   * actor (profiles) and the affected order. `orderId` is pulled out of the
   * append-only audit metadata; the order join is a LEFT join so an event
   * survives even if its order was later removed. Days are the SHOP's days
   * (BUSINESS_TIMEZONE): a payment at 01:00 IST on 1 July belongs to July, not
   * to June as a UTC-midnight cut would file it.
   */
  async getLedgerEvents(range: { from: string; to: string }, page: OrderListPage): Promise<LedgerEventsResult> {
    let events: LedgerEventsResult["events"];
    let total: number;
    const startsAt = sql`((${range.from}::date)::timestamp at time zone ${env.BUSINESS_TIMEZONE})`;
    const endsBefore = sql`(((${range.to}::date) + 1)::timestamp at time zone ${env.BUSINESS_TIMEZONE})`;
    try {
      // payment_audit_log (ADR 0008): typed values, written in each payment's own transaction.
      const rows = await db
        .select({
          id: paymentAuditLog.id,
          action: paymentAuditLog.action,
          createdAt: sql<string>`to_char(${paymentAuditLog.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
          actorName: profiles.fullName,
          orderId: paymentAuditLog.orderId,
          orderNumber: orders.orderNumber,
          amount: paymentAuditLog.amount,
          method: paymentAuditLog.method,
          paidAt: paymentAuditLog.paidAt,
          previousAmount: paymentAuditLog.previousAmount,
          previousMethod: paymentAuditLog.previousMethod,
          previousPaidAt: paymentAuditLog.previousPaidAt,
        })
        .from(paymentAuditLog)
        .leftJoin(profiles, eq(profiles.id, paymentAuditLog.actorId))
        .leftJoin(orders, eq(orders.id, paymentAuditLog.orderId))
        .where(and(sql`${paymentAuditLog.createdAt} >= ${startsAt}`, sql`${paymentAuditLog.createdAt} < ${endsBefore}`))
        .orderBy(desc(paymentAuditLog.createdAt))
        .limit(page.limit)
        .offset(page.offset);
      events = rows.map((r) => ({
        ...r,
        amount: toMoneyString(r.amount),
        previousAmount: r.previousAmount === null ? null : toMoneyString(r.previousAmount),
      }));

      const countRes = await db.execute(sql`
        select count(*)::int as total
        from payment_audit_log l
        where l.created_at >= ${startsAt}
          and l.created_at < ${endsBefore}
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
    return { ...row, totalAmount: row.totalAmount === null ? null : toMoneyString(row.totalAmount) };
  }

  async countOrdersDueByDay(
    range: { from: string; to: string },
    excludeOrderId?: string,
  ): Promise<{ date: string; count: number }[]> {
    const inRange = and(gte(orders.dueDate, range.from), lte(orders.dueDate, range.to));
    try {
      const rows = await db
        .select({ date: orders.dueDate, count: sql<number>`count(*)::int` })
        .from(orders)
        .where(excludeOrderId ? and(inRange, ne(orders.id, excludeOrderId)) : inRange)
        .groupBy(orders.dueDate)
        .orderBy(orders.dueDate);
      return rows;
    } catch (error) {
      throw new InternalError("Failed to load delivery load", error);
    }
  }

  async create(data: NewOrderRecord, assertDueDateCapacity?: DueDateCapacityGuard, leadLink?: LeadLink): Promise<OrderEntity> {
    let insertedId: string;
    try {
      insertedId = await db.transaction(async (tx) => {
        await bookingMonthsOpen(tx, "booking", data.bookingDate); // 409 -- not into a closed month
        const deliveryOverride = assertDueDateCapacity
          ? assertDueDateCapacity({ booked: await lockDayAndCount(tx, data.dueDate), previousDueDate: null })
          : undefined;
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
            totalAmount: data.totalAmount === null ? null : toMoneyString(data.totalAmount),
            productionStatus: data.productionStatus,
            designerInstructions: data.designerInstructions,
            specialNotes: data.specialNotes,
            createdBy: data.createdBy,
            updatedBy: data.updatedBy,
          })
          .returning({ id: orders.id, orderNumber: orders.orderNumber });
        if (!inserted) throw new InternalError("Failed to create order");

        // An order saved for a lead converts it here, in this transaction --
        // if the lead can't be converted, this throws and no order is created.
        if (leadLink) await convertLeadInTransaction(tx, leadLink, inserted);

        // A price given at booking is the order's first price -- recorded like
        // any later one (see changePrice()), in this same transaction.
        if (data.totalAmount !== null) {
          await tx.insert(orderPriceHistory).values({
            orderId: inserted.id,
            kind: "set",
            previousTotal: null,
            newTotal: toMoneyString(data.totalAmount),
            collected: "0.00",
            changedBy: data.createdBy,
          });
        }

        // A brand-new order's history starts with one entry for its initial
        // status -- the timeline is never empty, same as every subsequent
        // status change (see updateStatus()).
        await tx.insert(orderStatusHistory).values({
          orderId: inserted.id,
          status: data.productionStatus,
          label: granularLabel(data.productionStatus),
          changedBy: data.createdBy,
        });

        await logOrder(tx, {
          orderId: inserted.id,
          action: "created",
          actorId: data.createdBy,
          details: {
            ...(leadLink ? { leadId: leadLink.leadId } : {}),
            ...(deliveryOverride ? { deliveryOverride } : {}),
          },
        });

        return inserted.id;
      });
    } catch (error) {
      // Preserve domain errors (e.g. 409 DELIVERY_DAY_FULL from the capacity
      // guard); wrap only the unexpected.
      if (error instanceof AppError) throw error;
      throw new InternalError("Failed to create order", error);
    }

    const entity = await this.findByIdUnscoped(insertedId);
    if (!entity) throw new InternalError("Failed to create order");
    return entity;
  }

  async update(
    id: string,
    data: UpdateOrderRecord,
    expectedVersion?: number,
    assertDueDateCapacity?: DueDateCapacityGuard,
  ): Promise<OrderEntity> {
    // updated_at is deliberately not touched: orders_set_updated_at (a
    // BEFORE UPDATE trigger) already keeps it current. `version` is always
    // bumped so the next reader/editor sees a moved-on value (optimistic lock).
    const record: Partial<typeof orders.$inferInsert> = { ...data };

    try {
      await db.transaction(async (tx) => {
        // Lock the row and read what an edit can change: the optimistic-lock
        // version, the CURRENT due date (the capacity rule skips an edit that
        // doesn't move it), and the "before" values the audit log records.
        const [current] = await tx
          .select({
            version: orders.version,
            customerName: orders.customerName,
            phone: orders.phone,
            billNumber: orders.billNumber,
            bookingDate: orders.bookingDate,
            dueDate: orders.dueDate,
            nextPaymentDate: orders.nextPaymentDate,
            designerId: orders.designerId,
            masterTailorId: orders.masterTailorId,
            productCategory: orders.productCategory,
            orderDetails: orders.orderDetails,
            handWork: orders.handWork,
            machineWork: orders.machineWork,
            purchaseRequired: orders.purchaseRequired,
            designerInstructions: orders.designerInstructions,
            specialNotes: orders.specialNotes,
          })
          .from(orders)
          .where(eq(orders.id, id))
          .for("update");
        if (!current) throw new NotFoundError("Order not found", ERROR_CODES.ORDER_NOT_FOUND);
        // A version is the client's "as I loaded it": someone else saved since -> refuse, don't overwrite.
        if (expectedVersion !== undefined && current.version !== expectedVersion) {
          throw new ConflictError("This order was changed by someone else. Reload and try again.", ERROR_CODES.ORDER_MODIFIED);
        }
        // Moving the booking date: neither the old month nor the new one may be closed.
        if (data.bookingDate !== undefined && data.bookingDate !== current.bookingDate) {
          await bookingMonthsOpen(tx, "booking", current.bookingDate, data.bookingDate);
        }

        const deliveryOverride =
          assertDueDateCapacity && data.dueDate !== undefined
            ? assertDueDateCapacity({ booked: await lockDayAndCount(tx, data.dueDate, id), previousDueDate: current.dueDate })
            : undefined;

        await tx
          .update(orders)
          .set({ ...record, version: sql`${orders.version} + 1` })
          .where(eq(orders.id, id));

        // Log only what actually changed (an edit form resends every field).
        const changes = diffOrderFields(current, data);
        await labelPeople(tx, changes);
        if (Object.keys(changes).length > 0 || deliveryOverride) {
          await logOrder(tx, {
            orderId: id,
            action: "updated",
            actorId: data.updatedBy,
            changes,
            details: deliveryOverride ? { deliveryOverride } : null,
          });
        }
      });
    } catch (error) {
      // Preserve domain errors (404, 409 ORDER_MODIFIED, 409 DELIVERY_DAY_FULL); wrap the unexpected.
      if (error instanceof AppError) throw error;
      throw new InternalError("Failed to save order", error);
    }

    const entity = await this.findByIdUnscoped(id);
    if (!entity) throw new InternalError("Failed to save order");
    return entity;
  }

  async updateStatus(
    id: string,
    status: GranularStatus,
    changedBy: string,
    assertTransition?: (current: GranularStatus) => void,
  ): Promise<OrderEntity> {
    try {
      await db.transaction(async (tx) => {
        // Lock the order row for the duration of the transaction. Two staff
        // scanning the same order at once now serialize here: the second one
        // waits, then sees the already-advanced status and is rejected below --
        // no duplicate history rows, no concurrent double-advance.
        const rows = await tx
          .select({ current: orders.productionStatus, total: orders.totalAmount })
          .from(orders)
          .where(eq(orders.id, id))
          .for("update");
        const current = rows[0]?.current;
        if (!current) throw new NotFoundError("Order not found", ERROR_CODES.ORDER_NOT_FOUND);

        // The flow's shape: forward-only except Ready -> Alteration, Delivered
        // only from Ready. Rejecting the same stage also makes a repeat scan or
        // a concurrent double-advance a clean 409 (idempotency).
        assertStageMove(current, status);
        // Delivered needs a price (ADR 0008) -- judged on the locked row.
        assertPricedForDelivery(status, rows[0]!.total);

        // Caller-supplied transition rule (e.g. no skipping past a stage the
        // role can't set). Run HERE, against the locked `current`, rather than in
        // the service: a check made before the lock could see a stale stage. The
        // rule itself stays in the domain layer -- this only enforces it atomically.
        assertTransition?.(current);

        // updated_at is deliberately not touched here either -- same trigger as update().
        await tx.update(orders).set({ productionStatus: status, updatedBy: changedBy }).where(eq(orders.id, id));
        await tx.insert(orderStatusHistory).values({
          orderId: id,
          status,
          fromStatus: current,
          label: granularLabel(status),
          changedBy,
        });
      });
    } catch (error) {
      // Preserve every meaningful domain error (404 missing, 409 not-forward,
      // 403 from assertTransition); wrap only the unexpected as a 500.
      if (error instanceof AppError) throw error;
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

  async changePrice(
    id: string,
    request: { newTotal: string; changedBy: string },
    decide: (state: PriceState) => PriceChangeDecision,
  ): Promise<OrderPriceChangeEntity> {
    let changeId: string;
    try {
      changeId = await db.transaction(async (tx) => {
        // Lock the order row. Recording a payment locks it too, so a payment
        // and a price change on the same order serialise: "collected" and the
        // current total can't move between the check and the write.
        const [row] = await tx
          .select({ total: orders.totalAmount, designerId: orders.designerId, bookingDate: orders.bookingDate })
          .from(orders)
          .where(eq(orders.id, id))
          .for("update");
        if (!row) throw new NotFoundError("Order not found", ERROR_CODES.ORDER_NOT_FOUND);
        // The booking month's lock (a close holds it exclusively), then whether it's closed.
        const bookingMonth = row.bookingDate.slice(0, 7);
        await tx.execute(sql`select pg_advisory_xact_lock_shared(${LEDGER_MONTH_LOCK_NAMESPACE}::int, public.ledger_month_key(${row.bookingDate}::date))`);
        const closedRes = await tx.execute<{ closed: boolean }>(sql`select public.ledger_month_closed(${row.bookingDate}::date) as closed`);
        const [paid] = await tx
          .select({ sum: sql<string>`coalesce(sum(${payments.amount}), 0)` })
          .from(payments)
          .where(eq(payments.orderId, id));

        const previousTotal = row.total === null ? null : toMoneyString(row.total);
        const collected = toMoneyString(paid?.sum ?? 0);
        const newTotal = toMoneyString(request.newTotal);
        const decision = decide({
          currentTotal: previousTotal,
          designerId: row.designerId,
          collected,
          bookingMonth,
          bookingMonthClosed: closedRes.rows[0]?.closed === true,
        });

        const status = derivePaymentStatus(collected, newTotal);
        await tx
          .update(orders)
          .set({
            totalAmount: newTotal,
            paymentStatus: status,
            // Nothing left to collect -> nothing left to schedule (same as a settling payment).
            ...(status === "fully_paid" ? { nextPaymentDate: null } : {}),
            updatedBy: request.changedBy,
            version: sql`${orders.version} + 1`,
          })
          .where(eq(orders.id, id));
        const [inserted] = await tx
          .insert(orderPriceHistory)
          .values({
            orderId: id,
            kind: decision.kind,
            previousTotal,
            newTotal,
            collected,
            reason: decision.reason,
            changedBy: request.changedBy,
          })
          .returning({ id: orderPriceHistory.id });
        if (!inserted) throw new InternalError("Failed to save the price");
        return inserted.id;
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new InternalError("Failed to save the price", error);
    }

    const change = (await this.listPriceHistory(id)).find((c) => c.id === changeId);
    if (!change) throw new InternalError("Failed to save the price");
    return change;
  }

  async listPriceHistory(orderId: string): Promise<OrderPriceChangeEntity[]> {
    try {
      const rows = await db
        .select({
          id: orderPriceHistory.id,
          orderId: orderPriceHistory.orderId,
          kind: orderPriceHistory.kind,
          previousTotal: orderPriceHistory.previousTotal,
          newTotal: orderPriceHistory.newTotal,
          collected: orderPriceHistory.collected,
          reason: orderPriceHistory.reason,
          changedBy: orderPriceHistory.changedBy,
          changedByName: profiles.fullName,
          createdAt: orderPriceHistory.createdAt,
        })
        .from(orderPriceHistory)
        .leftJoin(profiles, eq(profiles.id, orderPriceHistory.changedBy))
        .where(eq(orderPriceHistory.orderId, orderId))
        .orderBy(desc(orderPriceHistory.createdAt));
      return rows.map((r) => ({
        ...r,
        previousTotal: r.previousTotal === null ? null : toMoneyString(r.previousTotal),
        newTotal: toMoneyString(r.newTotal),
        collected: toMoneyString(r.collected),
        changedByName: r.changedByName ?? null,
        createdAt: r.createdAt.toISOString(),
      }));
    } catch (error) {
      throw new InternalError("Failed to load the price history", error);
    }
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

  async deleteImage(orderId: string, slot: number, actorId: string): Promise<void> {
    await db.transaction(async (tx) => {
      const removed = await tx
        .delete(orderImages)
        .where(and(eq(orderImages.orderId, orderId), eq(orderImages.slot, slot)))
        .returning({ id: orderImages.id });
      if (removed.length > 0) await logOrder(tx, { orderId, action: "image_deleted", actorId, details: { slot } });
    });
  }

  async sumPaymentsForOrder(orderId: string): Promise<string> {
    let rows;
    try {
      rows = await db
        .select({ total: sql<string>`coalesce(sum(${payments.amount}), 0)` })
        .from(payments)
        .where(eq(payments.orderId, orderId));
    } catch (error) {
      throw new InternalError("Failed to sum payments", error);
    }
    return toMoneyString(rows[0]?.total ?? 0);
  }

  async sumPaymentsForOrders(orderIds: string[]): Promise<Record<string, string>> {
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

    const sums: Record<string, string> = {};
    for (const row of rows) sums[row.orderId] = toMoneyString(row.total);
    return sums;
  }
}
