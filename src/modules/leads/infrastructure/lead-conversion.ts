import { sql } from "drizzle-orm";
import type { db } from "../../../common/database/drizzle-client";
import { ConflictError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { convertibleFrom, type LeadActor } from "../domain/lead-status.rules";
import type { LeadStatus } from "../domain/lead.entity";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface LeadConversion {
  leadId: string;
  actorId: string;
  actor: LeadActor;
}

/**
 * Marks a lead Converted and links it to the order being created -- called by
 * the Orders repository INSIDE the order's insert transaction (an Infra->Infra
 * cross-module write, like Payments syncing orders; ADR 0003). If the lead
 * can't be converted -- not this designer's, not yet received, or already
 * closed -- it throws, the transaction rolls back, and no order is created:
 * the order and the conversion happen together or not at all.
 */
export async function convertLeadInTransaction(tx: Tx, conversion: LeadConversion, order: { id: string; orderNumber: string }): Promise<void> {
  const allowed = convertibleFrom(conversion.actor);
  const mine = conversion.actor === "owner" ? sql`true` : sql`assigned_to = ${conversion.actorId}::uuid`;
  const res = await tx.execute(sql`
    with prev as (
      select id, status from leads
      where id = ${conversion.leadId}::uuid
        and status in (${sql.join(allowed.map((s) => sql`${s}`), sql`, `)})
        and ${mine}
      for update
    )
    update leads l set
      status = 'converted', converted_order_id = ${order.id}::uuid, urgent = false, follow_up_on = null,
      version = l.version + 1, updated_at = now()
    from prev where l.id = prev.id
    returning prev.status as from_status`);
  const row = (res.rows as { from_status: LeadStatus }[])[0];
  if (!row) {
    throw new ConflictError(
      "This lead can't be converted (it isn't yours, hasn't been received yet, or is already closed)",
      ERROR_CODES.LEAD_NOT_CONVERTIBLE,
    );
  }
  await tx.execute(sql`
    insert into lead_events (lead_id, actor_id, kind, from_status, to_status, note)
    values (${conversion.leadId}::uuid, ${conversion.actorId}::uuid, 'converted', ${row.from_status}, 'converted', ${`Order ${order.orderNumber}`})`);
}
