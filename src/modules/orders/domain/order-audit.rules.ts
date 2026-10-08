/**
 * What the order audit log records (ADR 0008, phase 3). Pure -- the
 * repository runs diffOrderFields inside the edit's transaction, against the
 * row it has just locked, and writes the result in that same transaction.
 */
export type OrderAuditAction = "created" | "updated" | "image_deleted";

/** One field's change in an edit. `fromLabel` / `toLabel` carry a readable form when the value is an id (a person's name). */
export interface FieldChange {
  from: unknown;
  to: unknown;
  fromLabel?: string | null;
  toLabel?: string | null;
}

export type OrderFieldChanges = Record<string, FieldChange>;

/** The order fields an edit can change, in display order -- the only keys diffOrderFields compares. */
export const AUDITED_ORDER_FIELDS = [
  "customerName",
  "phone",
  "billNumber",
  "bookingDate",
  "dueDate",
  "nextPaymentDate",
  "designerId",
  "masterTailorId",
  "productCategory",
  "orderDetails",
  "handWork",
  "machineWork",
  "purchaseRequired",
  "designerInstructions",
  "specialNotes",
] as const;

export type AuditedOrderField = (typeof AUDITED_ORDER_FIELDS)[number];

/** The two fields that hold a person's id -- logged with names too. */
export const PERSON_FIELDS: readonly AuditedOrderField[] = ["designerId", "masterTailorId"];

/** Blank text and null are the same "nothing": an edit form sends "" for an emptied optional field. */
function normalize(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  return value;
}

/**
 * The fields an edit actually changes, with their before and after values.
 * Only submitted fields are compared -- an edit form resends every field, and
 * the unchanged ones are dropped -- so a save that changes nothing records
 * nothing.
 */
export function diffOrderFields(
  before: Partial<Record<AuditedOrderField, unknown>>,
  submitted: Partial<Record<AuditedOrderField, unknown>>,
): OrderFieldChanges {
  const changes: OrderFieldChanges = {};
  for (const field of AUDITED_ORDER_FIELDS) {
    if (submitted[field] === undefined) continue;
    const from = normalize(before[field]);
    const to = normalize(submitted[field]);
    if (from !== to) changes[field] = { from, to };
  }
  return changes;
}
