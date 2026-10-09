import { sql, type SQL } from "drizzle-orm";
import { db } from "../../../common/database/drizzle-client";
import { InternalError } from "../../../common/errors/app-error";
import { TRACKED_STAFF_ROLES, type ActivityCategory, type TrackedStaffRole } from "../domain/staff-activity.rules";
import type { ActivityCounts, ActivityEventEntity } from "../domain/staff-activity.entity";
import type {
  ActivityDayQuery,
  ReportsRepositoryPort,
  StaffWorkloadPage,
  StaffWorkloadQuery,
} from "../application/ports/reports-repository.port";
import { containsPattern } from "../../../common/database/like-pattern";

/** node-postgres returns { rows }; some drivers return the array itself. */
function rowsOf<T>(result: unknown): T[] {
  return (Array.isArray(result) ? result : ((result as { rows?: T[] }).rows ?? [])) as T[];
}

const ISO_UTC = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** A shop day's bounds as instants: midnight to midnight in the shop's timezone (a plain created_at range, so indexes apply). */
function dayBounds(day: string, timeZone: string): { from: SQL; to: SQL } {
  return {
    from: sql`((${day}::date)::timestamp at time zone ${timeZone})`,
    to: sql`(((${day}::date) + 1)::timestamp at time zone ${timeZone})`,
  };
}

/** audit_log keeps sign-ins and account events only (ADR 0008); older order.* / payment.* rows there are left out. */
const ACCOUNT_ACTIONS = sql`(a.action like 'auth.%' or a.action like 'user.%')`;

/**
 * Each category's rows for one day, in one shape: id, kind, at, actor_id,
 * order_id, lead_id, target_id, details. Money is cast to text so it stays a
 * 2dp string in the JSON.
 */
function categorySource(category: ActivityCategory, from: SQL, to: SQL): SQL {
  switch (category) {
    case "orders":
      return sql`
        select l.id, 'order.' || l.action as kind, l.created_at as at, l.actor_id, l.order_id,
               null::uuid as lead_id, null::uuid as target_id,
               jsonb_strip_nulls(jsonb_build_object('changes', l.changes, 'details', l.details)) as details
        from order_audit_log l
        where l.created_at >= ${from} and l.created_at < ${to}
        union all
        select p.id, 'price.' || p.kind, p.created_at, p.changed_by, p.order_id, null::uuid, null::uuid,
               jsonb_strip_nulls(jsonb_build_object(
                 'previousTotal', p.previous_total::text, 'newTotal', p.new_total::text,
                 'collected', p.collected::text, 'reason', p.reason))
        from order_price_history p
        where p.created_at >= ${from} and p.created_at < ${to}`;
    case "stages":
      return sql`
        select h.id, 'stage.moved' as kind, h.created_at as at, h.changed_by as actor_id, h.order_id,
               null::uuid as lead_id, null::uuid as target_id,
               jsonb_build_object('from', h.from_status, 'to', h.status) as details
        from order_status_history h
        where h.created_at >= ${from} and h.created_at < ${to} and h.from_status is not null`;
    case "payments":
      return sql`
        select l.id, 'payment.' || l.action as kind, l.created_at as at, l.actor_id, l.order_id,
               null::uuid as lead_id, null::uuid as target_id,
               jsonb_strip_nulls(jsonb_build_object(
                 'amount', l.amount::text, 'method', l.method, 'paidAt', l.paid_at,
                 'previousAmount', l.previous_amount::text, 'previousMethod', l.previous_method,
                 'previousPaidAt', l.previous_paid_at)) as details
        from payment_audit_log l
        where l.created_at >= ${from} and l.created_at < ${to}`;
    case "leads":
      return sql`
        select e.id, 'lead.' || e.kind as kind, e.created_at as at, e.actor_id,
               case when e.kind = 'converted' then ld.converted_order_id end as order_id,
               e.lead_id, null::uuid as target_id,
               jsonb_strip_nulls(jsonb_build_object(
                 'from', e.from_status, 'to', e.to_status, 'assignedTo', assignee.full_name,
                 'note', e.note, 'customerName', ld.customer_name)) as details
        from lead_events e
        join leads ld on ld.id = e.lead_id
        left join profiles assignee on assignee.id = e.assigned_to
        where e.created_at >= ${from} and e.created_at < ${to}`;
    case "accounts":
      return sql`
        select a.id, a.action as kind, a.created_at as at, a.actor_id, null::uuid as order_id,
               null::uuid as lead_id,
               -- CASE guards the uuid cast: entity_id is free text for other entity types.
               (case when a.entity_type = 'user' then a.entity_id end)::uuid as target_id,
               a.metadata as details
        from audit_log a
        where a.created_at >= ${from} and a.created_at < ${to} and ${ACCOUNT_ACTIONS}`;
  }
}

/**
 * Read-only reporting queries over tables other modules own (`profiles`,
 * `orders`, the order / payment / price / stage logs, `leads`, `audit_log`) -- an Infrastructure-level
 * read, the same pattern as the Orders module's staff report (see
 * docs/adr/0003-per-module-schema-ownership.md). Raw SQL because both queries
 * are aggregates / DISTINCT ON that the query builder would only obscure.
 */
export class DrizzleReportsRepository implements ReportsRepositoryPort {
  /**
   * One round trip, whatever the page size. The work is bounded by the OPEN
   * (undelivered) orders, never by history size:
   * - designers: open orders created in the window, grouped by creator;
   * - floor: for each open order, its single latest stage move -- a LATERAL
   *   `limit 1` on order_status_history (order_id, created_at), so history
   *   rows of delivered orders are never read;
   * - "last seen" (one indexed probe per person on audit_log (actor_id,
   *   created_at)) runs only for the rows on THIS page.
   * Counts for the summary tiles come from the same scan (window-free
   * aggregate over the search/role-filtered staff).
   */
  async getStaffWorkload(query: StaffWorkloadQuery): Promise<StaffWorkloadPage> {
    const roles = sql.join(
      TRACKED_STAFF_ROLES.map((r) => sql`${r}`),
      sql`, `,
    );
    const roleFilter = query.role ? sql`and role = ${query.role}` : sql``;
    const searchFilter = query.search ? sql`and full_name ilike ${containsPattern(query.search)}` : sql``;
    const statusFilter =
      query.status === "working" ? sql`where open_orders > 0` : query.status === "idle" ? sql`where open_orders = 0` : sql``;
    try {
      const result = await db.execute(sql`
        with staff as (
          select id, full_name, role
          from profiles
          where active and role in (${roles}) ${roleFilter} ${searchFilter}
        ),
        open_orders as (
          select id, created_by, created_at
          from orders
          where production_status <> 'delivered'
        ),
        -- Designers: open orders they created within their window.
        designer_work as (
          select created_by as staff_id, count(*)::int as open_orders, max(created_at) as last_at
          from open_orders
          where created_at >= now() - make_interval(days => ${query.designerWindowDays})
          group by created_by
        ),
        -- Everyone else: open orders whose LATEST stage move was theirs, within their window.
        floor_work as (
          select lm.changed_by as staff_id, count(*)::int as open_orders, max(lm.created_at) as last_at
          from open_orders o
          cross join lateral (
            select h.changed_by, h.created_at
            from order_status_history h
            where h.order_id = o.id
            order by h.created_at desc
            limit 1
          ) lm
          where lm.created_at >= now() - make_interval(hours => ${query.floorWindowHours})
          group by lm.changed_by
        ),
        scored as (
          select
            s.id, s.full_name, s.role,
            coalesce(case when s.role = 'designer' then d.open_orders else f.open_orders end, 0) as open_orders,
            case when s.role = 'designer' then d.last_at else f.last_at end as last_at
          from staff s
          left join designer_work d on d.staff_id = s.id and s.role = 'designer'
          left join floor_work f on f.staff_id = s.id and s.role <> 'designer'
        ),
        counts as (
          select
            count(*) filter (where open_orders > 0)::int as working,
            count(*) filter (where open_orders = 0)::int as idle
          from scored
        ),
        filtered as (
          select *, count(*) over ()::int as total from scored ${statusFilter}
        ),
        paged as (
          select * from filtered
          order by (open_orders > 0) desc,
            case role when 'designer' then 1 when 'master_tailor' then 2 when 'production_manager' then 3 else 4 end,
            open_orders desc, full_name, id
          limit ${query.limit} offset ${query.offset}
        )
        select
          c.working, c.idle,
          p.total,
          p.id::text as id, p.full_name, p.role, p.open_orders,
          to_char(p.last_at at time zone 'UTC', ${sql.raw(ISO_UTC)}) as last_work_at,
          to_char(seen.last_seen at time zone 'UTC', ${sql.raw(ISO_UTC)}) as last_seen_at
        from counts c
        left join paged p on true
        -- "Last seen" = their latest row in ANY log (ADR 0008 split them): one
        -- indexed top-1 probe per log on (actor, created_at).
        left join lateral (
          select max(t) as last_seen from (
            (select a.created_at as t from audit_log a where a.actor_id = p.id order by a.created_at desc limit 1)
            union all
            (select l.created_at from order_audit_log l where l.actor_id = p.id order by l.created_at desc limit 1)
            union all
            (select l.created_at from payment_audit_log l where l.actor_id = p.id order by l.created_at desc limit 1)
            union all
            (select h.created_at from order_status_history h where h.changed_by = p.id order by h.created_at desc limit 1)
            union all
            (select ph.created_at from order_price_history ph where ph.changed_by = p.id order by ph.created_at desc limit 1)
            union all
            (select e.created_at from lead_events e where e.actor_id = p.id order by e.created_at desc limit 1)
          ) latest
        ) seen on p.id is not null
        order by (p.open_orders > 0) desc,
          case p.role when 'designer' then 1 when 'master_tailor' then 2 when 'production_manager' then 3 else 4 end,
          p.open_orders desc, p.full_name, p.id
      `);
      const list = rowsOf<{
        working: number;
        idle: number;
        total: number | null;
        id: string | null;
        full_name: string;
        role: TrackedStaffRole;
        open_orders: number;
        last_work_at: string | null;
        last_seen_at: string | null;
      }>(result);
      const first = list[0];
      // A page past the end still returns the counts row (id null) -- the true
      // total then needs its own count, but that only happens on a bad offset.
      const rows = list.filter((r) => r.id !== null);
      return {
        counts: { working: Number(first?.working ?? 0), idle: Number(first?.idle ?? 0) },
        total: rows.length > 0 ? Number(rows[0]!.total) : await this.countStaff(query),
        rows: rows.map((r) => ({
          id: r.id!,
          fullName: r.full_name,
          role: r.role,
          openOrders: Number(r.open_orders),
          lastWorkAt: r.last_work_at,
          lastSeenAt: r.last_seen_at,
        })),
      };
    } catch (error) {
      throw new InternalError("Failed to load staff workload", error);
    }
  }

  /** Only for an offset past the end: how many rows the filters match. */
  private async countStaff(query: StaffWorkloadQuery): Promise<number> {
    if (query.offset === 0) return 0;
    const page = await this.getStaffWorkload({ ...query, limit: 1, offset: 0 });
    return page.total;
  }

  async getActivityDay(query: ActivityDayQuery): Promise<ActivityEventEntity[]> {
    const { from, to } = dayBounds(query.day, query.timeZone);
    try {
      const result = await db.execute(sql`
        select
          e.id::text as id,
          e.kind,
          to_char(e.at at time zone 'UTC', ${sql.raw(ISO_UTC)}) as at,
          actor.full_name as actor_name,
          actor.role as actor_role,
          e.order_id::text as order_id,
          o.order_number,
          e.lead_id::text as lead_id,
          ld.lead_number,
          target.full_name as target_name,
          e.details
        -- The page FIRST, then the names: a busy day's hundreds of events never
        -- get joined to orders / leads (the planner turned that into full scans).
        from (
          select * from (${categorySource(query.category, from, to)}) day_events
          order by at desc, id desc
          limit ${query.limit} offset ${query.offset}
        ) e
        left join profiles actor on actor.id = e.actor_id
        left join orders o on o.id = e.order_id
        left join leads ld on ld.id = e.lead_id
        left join profiles target on target.id = e.target_id
        order by e.at desc, e.id desc
      `);
      return rowsOf<{
        id: string;
        kind: string;
        at: string;
        actor_name: string | null;
        actor_role: string | null;
        order_id: string | null;
        order_number: string | null;
        lead_id: string | null;
        lead_number: string | null;
        target_name: string | null;
        details: Record<string, unknown> | null;
      }>(result).map((r) => ({
        id: r.id,
        category: query.category,
        kind: r.kind,
        at: r.at,
        actorName: r.actor_name,
        actorRole: r.actor_role,
        orderId: r.order_id,
        orderNumber: r.order_number,
        leadId: r.lead_id,
        leadNumber: r.lead_number,
        targetName: r.target_name,
        details: r.details,
      }));
    } catch (error) {
      throw new InternalError("Failed to load the activity feed", error);
    }
  }

  async getActivityCounts(day: string, timeZone: string): Promise<ActivityCounts> {
    const { from, to } = dayBounds(day, timeZone);
    try {
      const result = await db.execute(sql`
        select
          (select count(*) from order_audit_log l where l.created_at >= ${from} and l.created_at < ${to})
            + (select count(*) from order_price_history p where p.created_at >= ${from} and p.created_at < ${to}) as orders,
          (select count(*) from order_status_history h
            where h.created_at >= ${from} and h.created_at < ${to} and h.from_status is not null) as stages,
          (select count(*) from payment_audit_log l where l.created_at >= ${from} and l.created_at < ${to}) as payments,
          (select count(*) from lead_events e where e.created_at >= ${from} and e.created_at < ${to}) as leads,
          (select count(*) from audit_log a where a.created_at >= ${from} and a.created_at < ${to} and ${ACCOUNT_ACTIONS}) as accounts
      `);
      const row = rowsOf<Record<keyof ActivityCounts, string | number>>(result)[0];
      return {
        orders: Number(row?.orders ?? 0),
        stages: Number(row?.stages ?? 0),
        payments: Number(row?.payments ?? 0),
        leads: Number(row?.leads ?? 0),
        accounts: Number(row?.accounts ?? 0),
      };
    } catch (error) {
      throw new InternalError("Failed to count the day's activity", error);
    }
  }
}
