import { sql, type SQL } from "drizzle-orm";
import { db } from "../../../common/database/drizzle-client";
import { AppError, ConflictError, InternalError, NotFoundError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { containsPattern } from "../../../common/database/like-pattern";
import { decideEnquiry } from "../domain/enquiry.rules";
import { statusAfterRepeatEnquiry } from "../domain/lead-status.rules";
import { LEAD_STATUSES, type LeadCommentEntity, type LeadEntity, type LeadEventEntity, type LeadStatus } from "../domain/lead.entity";
import type {
  DesignerStatsPage,
  EnquiryInput,
  EnquiryOutcome,
  LeadListQuery,
  LeadListResult,
  LeadScope,
  LeadsRepository,
  LeadSummary,
  NewManualLead,
  StatusChangeDecision,
} from "../application/ports/leads-repository.port";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Executor = typeof db | Tx;

/** Namespace for the per-phone advisory lock (first key of the two-int form) -- distinct from the orders' 4201. */
export const ENQUIRY_PHONE_LOCK_NAMESPACE = 4202;

const OPEN_STATUSES: LeadStatus[] = ["new", "assigned", "unattended", "attended", "follow_up"];

/** Every column a LeadEntity needs, with the people's names and the converted order's number joined in. */
const LEAD_SELECT = sql`
  select
    l.id::text, l.lead_number, l.customer_name, l.phone, l.requirement, l.source, l.status,
    l.assigned_to::text, a.full_name as assigned_to_name, l.assigned_at,
    l.urgent, l.enquiry_count, l.first_enquiry_at, l.last_enquiry_at,
    l.follow_up_on::text as follow_up_on, l.lost_reason,
    l.converted_order_id::text, o.order_number as converted_order_number,
    l.created_by::text, c.full_name as created_by_name,
    l.version, l.created_at, l.updated_at
  from leads l
  left join profiles a on a.id = l.assigned_to
  left join profiles c on c.id = l.created_by
  left join orders o on o.id = l.converted_order_id`;

type LeadRow = {
  id: string;
  lead_number: string;
  customer_name: string;
  phone: string;
  requirement: string;
  source: LeadEntity["source"];
  status: LeadStatus;
  assigned_to: string | null;
  assigned_to_name: string | null;
  assigned_at: Date | string | null;
  urgent: boolean;
  enquiry_count: number;
  first_enquiry_at: Date | string;
  last_enquiry_at: Date | string;
  follow_up_on: string | null;
  lost_reason: string | null;
  converted_order_id: string | null;
  converted_order_number: string | null;
  created_by: string | null;
  created_by_name: string | null;
  version: number;
  created_at: Date | string;
  updated_at: Date | string;
};

const iso = (v: Date | string): string => (v instanceof Date ? v : new Date(v)).toISOString();
const isoOrNull = (v: Date | string | null): string | null => (v === null ? null : iso(v));

function rowsOf<T>(result: unknown): T[] {
  const r = result as { rows?: T[] };
  return r.rows ?? (result as T[]);
}

function toLead(r: LeadRow): LeadEntity {
  return {
    id: r.id,
    leadNumber: r.lead_number,
    customerName: r.customer_name,
    phone: r.phone,
    requirement: r.requirement,
    source: r.source,
    status: r.status,
    assignedTo: r.assigned_to,
    assignedToName: r.assigned_to_name,
    assignedAt: isoOrNull(r.assigned_at),
    urgent: r.urgent,
    enquiryCount: Number(r.enquiry_count),
    firstEnquiryAt: iso(r.first_enquiry_at),
    lastEnquiryAt: iso(r.last_enquiry_at),
    followUpOn: r.follow_up_on,
    lostReason: r.lost_reason,
    convertedOrderId: r.converted_order_id,
    convertedOrderNumber: r.converted_order_number,
    createdBy: r.created_by,
    createdByName: r.created_by_name,
    version: Number(r.version),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}

function scopeCondition(scope: LeadScope): SQL {
  return scope.kind === "all" ? sql`true` : sql`l.assigned_to = ${scope.userId}::uuid`;
}

function statusList(statuses: readonly LeadStatus[]): SQL {
  return sql.join(
    statuses.map((s) => sql`${s}`),
    sql`, `,
  );
}

/** Wraps unexpected failures; lets the app's own errors (404/409/...) through. */
async function guarded<T>(what: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new InternalError(`Failed to ${what}`, error);
  }
}

async function selectLead(ex: Executor, id: string, forUpdate = false): Promise<LeadEntity | null> {
  // FOR UPDATE OF l: lock only the lead row, not the joined profiles/orders rows.
  const lock = forUpdate ? sql` for update of l` : sql``;
  const res = await ex.execute(sql`${LEAD_SELECT} where l.id = ${id}::uuid${lock}`);
  const [row] = rowsOf<LeadRow>(res);
  return row ? toLead(row) : null;
}

async function insertEvent(
  ex: Executor,
  e: { leadId: string; actorId: string | null; kind: LeadEventEntity["kind"]; fromStatus?: LeadStatus | null; toStatus?: LeadStatus | null; assignedTo?: string | null; note?: string | null },
): Promise<void> {
  await ex.execute(sql`
    insert into lead_events (lead_id, actor_id, kind, from_status, to_status, assigned_to, note)
    values (${e.leadId}::uuid, ${e.actorId}::uuid, ${e.kind}, ${e.fromStatus ?? null}, ${e.toStatus ?? null}, ${e.assignedTo ?? null}::uuid, ${e.note ?? null})`);
}

function assertVersion(current: LeadEntity, expected: number | undefined): void {
  if (expected !== undefined && current.version !== expected) {
    throw new ConflictError("This lead was changed by someone else — reload and try again", ERROR_CODES.LEAD_MODIFIED);
  }
}

export class DrizzleLeadsRepository implements LeadsRepository {
  list(query: LeadListQuery): Promise<LeadListResult> {
    return guarded("load leads", async () => {
      const conditions: SQL[] = [scopeCondition(query.scope)];
      if (query.status === "open") conditions.push(sql`l.status in (${statusList(OPEN_STATUSES)})`);
      else if (query.status) conditions.push(sql`l.status = ${query.status}`);
      if (query.urgentOnly) conditions.push(sql`l.urgent`);
      if (query.assignedTo) conditions.push(sql`l.assigned_to = ${query.assignedTo}::uuid`);
      if (query.q) {
        const term = containsPattern(query.q);
        conditions.push(sql`(l.customer_name ilike ${term} or l.phone ilike ${term} or l.lead_number ilike ${term})`);
      }
      const where = sql.join(conditions, sql` and `);

      const res = await db.execute(sql`${LEAD_SELECT} where ${where}
        order by l.urgent desc, l.created_at desc
        limit ${query.limit} offset ${query.offset}`);
      const countRes = await db.execute(sql`select count(*)::int as total from leads l where ${where}`);
      return { leads: rowsOf<LeadRow>(res).map(toLead), total: Number(rowsOf<{ total: number }>(countRes)[0]?.total ?? 0) };
    });
  }

  summary(scope: LeadScope): Promise<LeadSummary> {
    return guarded("load the leads summary", async () => {
      const res = await db.execute(sql`
        select l.status, count(*)::int as n, count(*) filter (where l.urgent and l.status in (${statusList(OPEN_STATUSES)}))::int as urgent
        from leads l where ${scopeCondition(scope)} group by l.status`);
      const byStatus = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0])) as Record<LeadStatus, number>;
      let urgent = 0;
      for (const r of rowsOf<{ status: LeadStatus; n: number; urgent: number }>(res)) {
        byStatus[r.status] = Number(r.n);
        urgent += Number(r.urgent);
      }
      return { byStatus, urgent };
    });
  }

  designerStats(query: { q?: string; limit: number; offset: number }): Promise<DesignerStatsPage> {
    return guarded("load the designers' lead counts", async () => {
      // One grouped pass over leads, joined to the page's designers; the total
      // rides along as a window count so the pager needs no second query.
      const nameFilter = query.q ? sql`and p.full_name ilike ${containsPattern(query.q)}` : sql``;
      const res = await db.execute(sql`
        with stats as (
          select l.assigned_to as id,
            count(*) filter (where l.status in ('assigned', 'unattended', 'attended', 'follow_up'))::int as open,
            count(*) filter (where l.status = 'assigned')::int as waiting,
            count(*) filter (where l.status = 'converted')::int as converted,
            count(*) filter (where l.status = 'lost')::int as lost
          from leads l
          where l.assigned_to is not null
          group by l.assigned_to
        )
        select p.id::text as designer_id, p.full_name as designer_name, s.open, s.waiting, s.converted, s.lost,
          count(*) over ()::int as total
        from stats s
        join profiles p on p.id = s.id
        where true ${nameFilter}
        order by s.open desc, s.waiting desc, p.full_name
        limit ${query.limit} offset ${query.offset}`);
      const rows = rowsOf<{ designer_id: string; designer_name: string; open: number; waiting: number; converted: number; lost: number; total: number }>(res);
      let total = Number(rows[0]?.total ?? 0);
      if (rows.length === 0 && query.offset > 0) {
        // Past the last page: the window count is empty, so count separately.
        const c = await db.execute(sql`
          select count(distinct l.assigned_to)::int as n from leads l join profiles p on p.id = l.assigned_to
          where l.assigned_to is not null ${nameFilter}`);
        total = Number(rowsOf<{ n: number }>(c)[0]?.n ?? 0);
      }
      return {
        designers: rows.map((r) => ({
          designerId: r.designer_id,
          designerName: r.designer_name,
          open: Number(r.open),
          waiting: Number(r.waiting),
          converted: Number(r.converted),
          lost: Number(r.lost),
        })),
        total,
      };
    });
  }

  badgeCount(scope: LeadScope): Promise<number> {
    return guarded("count new leads", async () => {
      const res =
        scope.kind === "all"
          ? await db.execute(sql`select count(*)::int as n from leads where status = 'new'`)
          : await db.execute(sql`
              select count(*)::int as n from leads
              where assigned_to = ${scope.userId}::uuid
                and (status = 'assigned' or (urgent and status in (${statusList(OPEN_STATUSES)})))`);
      return Number(rowsOf<{ n: number }>(res)[0]?.n ?? 0);
    });
  }

  findById(id: string): Promise<LeadEntity | null> {
    return guarded("load the lead", () => selectLead(db, id));
  }

  listComments(leadId: string): Promise<LeadCommentEntity[]> {
    return guarded("load comments", async () => {
      const res = await db.execute(sql`
        select c.id::text, c.lead_id::text, c.author_id::text, p.full_name as author_name, c.body, c.created_at
        from lead_comments c left join profiles p on p.id = c.author_id
        where c.lead_id = ${leadId}::uuid order by c.created_at`);
      return rowsOf<{ id: string; lead_id: string; author_id: string | null; author_name: string | null; body: string; created_at: Date | string }>(res).map(
        (r) => ({ id: r.id, leadId: r.lead_id, authorId: r.author_id, authorName: r.author_name, body: r.body, createdAt: iso(r.created_at) }),
      );
    });
  }

  listEvents(leadId: string): Promise<LeadEventEntity[]> {
    return guarded("load the lead history", async () => {
      const res = await db.execute(sql`
        select e.id::text, e.lead_id::text, e.actor_id::text, p.full_name as actor_name, e.kind, e.from_status, e.to_status,
          e.assigned_to::text, d.full_name as assigned_to_name, e.note, e.created_at
        from lead_events e
        left join profiles p on p.id = e.actor_id
        left join profiles d on d.id = e.assigned_to
        where e.lead_id = ${leadId}::uuid order by e.created_at`);
      return rowsOf<{
        id: string;
        lead_id: string;
        actor_id: string | null;
        actor_name: string | null;
        kind: LeadEventEntity["kind"];
        from_status: LeadStatus | null;
        to_status: LeadStatus | null;
        assigned_to: string | null;
        assigned_to_name: string | null;
        note: string | null;
        created_at: Date | string;
      }>(res).map((r) => ({
        id: r.id,
        leadId: r.lead_id,
        actorId: r.actor_id,
        actorName: r.actor_name,
        kind: r.kind,
        fromStatus: r.from_status,
        toStatus: r.to_status,
        assignedTo: r.assigned_to,
        assignedToName: r.assigned_to_name,
        note: r.note,
        createdAt: iso(r.created_at),
      }));
    });
  }

  findSamePhone(phone: string, excludeId: string, limit: number) {
    return guarded("load related leads", async () => {
      const res = await db.execute(sql`
        select id::text, lead_number, status, created_at from leads
        where phone = ${phone} and id <> ${excludeId}::uuid
        order by created_at desc limit ${limit}`);
      return rowsOf<{ id: string; lead_number: string; status: LeadStatus; created_at: Date | string }>(res).map((r) => ({
        id: r.id,
        leadNumber: r.lead_number,
        status: r.status,
        createdAt: iso(r.created_at),
      }));
    });
  }

  isActiveDesigner(userId: string): Promise<boolean> {
    return guarded("check the designer", async () => {
      const res = await db.execute(sql`select 1 from profiles where id = ${userId}::uuid and role = 'designer' and active`);
      return rowsOf(res).length > 0;
    });
  }

  createManual(data: NewManualLead): Promise<LeadEntity> {
    return guarded("add the lead", async () => {
      const id = await db.transaction(async (tx) => {
        const status: LeadStatus = data.assignTo ? "assigned" : "new";
        const res = await tx.execute(sql`
          insert into leads (lead_number, customer_name, phone, requirement, source, status, assigned_to, assigned_at, created_by)
          values ('', ${data.customerName}, ${data.phone}, ${data.requirement}, ${data.source}, ${status},
                  ${data.assignTo}::uuid, ${data.assignTo ? sql`now()` : sql`null`}, ${data.createdBy}::uuid)
          returning id::text`);
        const leadId = rowsOf<{ id: string }>(res)[0]!.id;
        await insertEvent(tx, { leadId, actorId: data.createdBy, kind: "created", toStatus: "new" });
        if (data.assignTo) {
          await insertEvent(tx, { leadId, actorId: data.createdBy, kind: "assigned", fromStatus: "new", toStatus: "assigned", assignedTo: data.assignTo });
        }
        return leadId;
      });
      const lead = await selectLead(db, id);
      if (!lead) throw new InternalError("Failed to add the lead");
      return lead;
    });
  }

  submitEnquiry(input: EnquiryInput, now: Date): Promise<EnquiryOutcome> {
    return guarded("save the enquiry", () =>
      db.transaction(async (tx) => {
        // One enquiry per phone at a time: two quick submits can't both be "the first".
        await tx.execute(sql`select pg_advisory_xact_lock(${ENQUIRY_PHONE_LOCK_NAMESPACE}::int, hashtext(${input.phone}::text))`);
        const latestRes = await tx.execute(sql`
          select id::text, first_enquiry_at, enquiry_count, status, assigned_to::text, customer_name
          from leads where phone = ${input.phone}
          order by first_enquiry_at desc limit 1 for update`);
        const latest = rowsOf<{ id: string; first_enquiry_at: Date | string; enquiry_count: number; status: LeadStatus; assigned_to: string | null; customer_name: string }>(latestRes)[0];

        const decision = decideEnquiry(
          latest ? { id: latest.id, firstEnquiryAt: new Date(latest.first_enquiry_at), enquiryCount: Number(latest.enquiry_count) } : null,
          now,
        );

        if (decision.kind === "limit") return "limit";

        if (decision.kind === "create") {
          const res = await tx.execute(sql`
            insert into leads (lead_number, customer_name, phone, requirement, source, status, first_enquiry_at, last_enquiry_at)
            values ('', ${input.customerName}, ${input.phone}, ${input.requirement}, 'public_form', 'new', ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)
            returning id::text`);
          const leadId = rowsOf<{ id: string }>(res)[0]!.id;
          await insertEvent(tx, { leadId, actorId: null, kind: "created", toStatus: "new" });
          return "created";
        }

        // Merge the 2nd enquiry into the lead: urgent, and reopened if it had been closed.
        const prev = latest!;
        const next = statusAfterRepeatEnquiry(prev.status, prev.assigned_to !== null);
        await tx.execute(sql`
          update leads set
            enquiry_count = enquiry_count + 1,
            last_enquiry_at = ${now.toISOString()}::timestamptz,
            urgent = true,
            status = ${next},
            lost_reason = ${next === prev.status ? sql`lost_reason` : sql`null`},
            version = version + 1,
            updated_at = now()
          where id = ${decision.leadId}::uuid`);
        const nameNote = input.customerName !== prev.customer_name ? `Name given: ${input.customerName}\n` : "";
        await insertEvent(tx, { leadId: decision.leadId, actorId: null, kind: "enquiry_merged", note: `${nameNote}${input.requirement}`.slice(0, 1200) });
        if (next !== prev.status) {
          await insertEvent(tx, { leadId: decision.leadId, actorId: null, kind: "status_changed", fromStatus: prev.status, toStatus: next, note: "Reopened by a repeat enquiry" });
        }
        return "merged";
      }),
    );
  }

  assign(id: string, designerId: string, actorId: string, assertAssignable: (current: LeadEntity) => void, expectedVersion?: number): Promise<LeadEntity> {
    return guarded("assign the lead", async () => {
      await db.transaction(async (tx) => {
        const current = await selectLead(tx, id, true);
        if (!current) throw new NotFoundError("Lead not found", ERROR_CODES.LEAD_NOT_FOUND);
        assertVersion(current, expectedVersion);
        assertAssignable(current);
        await tx.execute(sql`
          update leads set assigned_to = ${designerId}::uuid, assigned_at = now(), status = 'assigned',
            version = version + 1, updated_at = now()
          where id = ${id}::uuid`);
        await insertEvent(tx, { leadId: id, actorId, kind: "assigned", fromStatus: current.status, toStatus: "assigned", assignedTo: designerId });
      });
      return (await selectLead(db, id))!;
    });
  }

  changeStatus(id: string, actorId: string, decide: StatusChangeDecision, expectedVersion?: number): Promise<LeadEntity> {
    return guarded("change the lead's stage", async () => {
      await db.transaction(async (tx) => {
        const current = await selectLead(tx, id, true);
        if (!current) throw new NotFoundError("Lead not found", ERROR_CODES.LEAD_NOT_FOUND);
        assertVersion(current, expectedVersion);
        const d = decide(current);
        await tx.execute(sql`
          update leads set
            status = ${d.to},
            follow_up_on = ${d.to === "follow_up" ? d.followUpOn : null}::date,
            lost_reason = ${d.to === "lost" ? d.lostReason : null},
            urgent = ${d.clearUrgent ? sql`false` : sql`urgent`},
            version = version + 1,
            updated_at = now()
          where id = ${id}::uuid`);
        await insertEvent(tx, { leadId: id, actorId, kind: "status_changed", fromStatus: current.status, toStatus: d.to, note: d.note });
      });
      return (await selectLead(db, id))!;
    });
  }

  addComment(leadId: string, authorId: string, body: string): Promise<LeadCommentEntity> {
    return guarded("add the comment", async () => {
      const res = await db.execute(sql`
        with c as (
          insert into lead_comments (lead_id, author_id, body) values (${leadId}::uuid, ${authorId}::uuid, ${body})
          returning id, lead_id, author_id, body, created_at
        )
        select c.id::text, c.lead_id::text, c.author_id::text, p.full_name as author_name, c.body, c.created_at
        from c left join profiles p on p.id = c.author_id`);
      const r = rowsOf<{ id: string; lead_id: string; author_id: string | null; author_name: string | null; body: string; created_at: Date | string }>(res)[0]!;
      // A comment is activity on the lead -- bump updated_at so lists show it as recently touched.
      await db.execute(sql`update leads set updated_at = now() where id = ${leadId}::uuid`);
      return { id: r.id, leadId: r.lead_id, authorId: r.author_id, authorName: r.author_name, body: r.body, createdAt: iso(r.created_at) };
    });
  }
}
