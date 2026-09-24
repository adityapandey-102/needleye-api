import { sql } from "drizzle-orm";
import { db } from "../../../common/database/drizzle-client";
import { InternalError } from "../../../common/errors/app-error";
import { TRACKED_STAFF_ROLES, type TrackedStaffRole } from "../domain/staff-activity.rules";
import type { ActivityEventEntity } from "../domain/staff-activity.entity";
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

/**
 * Read-only reporting queries over tables other modules own (`profiles`,
 * `orders`, `order_status_history`, `audit_log`) -- an Infrastructure-level
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
          where lm.created_at >= now() - make_interval(days => ${query.floorWindowDays})
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
        left join lateral (
          select a.created_at as last_seen
          from audit_log a
          where a.actor_id = p.id
          order by a.created_at desc
          limit 1
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

  async getActivityDay(query: ActivityDayQuery): Promise<{ events: ActivityEventEntity[]; total: number }> {
    // The day's bounds are midnight-to-midnight in the SHOP's timezone,
    // expressed as instants -- a plain range on created_at, so the
    // created_at index applies.
    const where = sql`
      a.created_at >= ((${query.day}::date)::timestamp at time zone ${query.timeZone})
      and a.created_at < (((${query.day}::date) + 1)::timestamp at time zone ${query.timeZone})
      ${sql.join(
        query.excludePrefixes.map((p) => sql`and a.action not like ${`${p}%`}`),
        sql` `,
      )}
    `;
    try {
      const result = await db.execute(sql`
        select
          a.id::text as id,
          a.action,
          a.entity_type,
          a.entity_id,
          to_char(a.created_at at time zone 'UTC', ${sql.raw(ISO_UTC)}) as at,
          actor.full_name as actor_name,
          actor.role as actor_role,
          o.order_number,
          target.full_name as target_name,
          a.metadata
        from audit_log a
        left join profiles actor on actor.id = a.actor_id
        -- CASE guards the uuid casts: entity_id is free text for other entity types.
        left join orders o on o.id = (case when a.entity_type = 'order' then a.entity_id end)::uuid
        left join profiles target on target.id = (case when a.entity_type = 'user' then a.entity_id end)::uuid
        where ${where}
        order by a.created_at desc
        limit ${query.limit} offset ${query.offset}
      `);
      const count = await db.execute(sql`select count(*)::int as total from audit_log a where ${where}`);
      const events = rowsOf<{
        id: string;
        action: string;
        entity_type: string;
        entity_id: string | null;
        at: string;
        actor_name: string | null;
        actor_role: string | null;
        order_number: string | null;
        target_name: string | null;
        metadata: Record<string, unknown> | null;
      }>(result).map((r) => ({
        id: r.id,
        action: r.action,
        entityType: r.entity_type,
        entityId: r.entity_id,
        at: r.at,
        actorName: r.actor_name,
        actorRole: r.actor_role,
        orderNumber: r.order_number,
        targetName: r.target_name,
        metadata: r.metadata,
      }));
      return { events, total: Number(rowsOf<{ total: number }>(count)[0]?.total ?? 0) };
    } catch (error) {
      throw new InternalError("Failed to load the activity feed", error);
    }
  }
}
