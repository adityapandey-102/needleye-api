import type { LeadCommentEntity, LeadEntity, LeadEventEntity, LeadSource, LeadStatus } from "../../domain/lead.entity";

/** Whose leads a query may see: the owner's whole book, or one designer's own. */
export type LeadScope = { kind: "all" } | { kind: "assigned"; userId: string };

/** A list filter. `open` = every stage that isn't converted / lost / discarded. */
export type LeadStatusFilter = LeadStatus | "open";

export interface LeadListQuery {
  scope: LeadScope;
  status?: LeadStatusFilter;
  urgentOnly?: boolean;
  /** Search: customer name, phone or lead number (contains, case-insensitive). */
  q?: string;
  /** Owner only: one designer's leads. */
  assignedTo?: string;
  limit: number;
  offset: number;
}

export interface LeadListResult {
  leads: LeadEntity[];
  total: number;
}

export interface DesignerLeadStats {
  designerId: string;
  designerName: string;
  /** Leads still being worked (assigned / unattended / attended / follow-up). */
  open: number;
  /** Assigned but not yet received -- their badge. */
  waiting: number;
  converted: number;
  lost: number;
}

export interface LeadSummary {
  byStatus: Record<LeadStatus, number>;
  /** Open leads flagged urgent (a repeat enquiry not yet contacted). */
  urgent: number;
}

/** One page of the owner's "Designers" table -- searched by name, paged in the database. */
export interface DesignerStatsPage {
  designers: DesignerLeadStats[];
  total: number;
}

export interface NewManualLead {
  customerName: string;
  phone: string;
  requirement: string;
  source: Exclude<LeadSource, "public_form">;
  /** Optionally assign straight away (an active designer). */
  assignTo: string | null;
  createdBy: string;
}

export interface EnquiryInput {
  customerName: string;
  phone: string;
  requirement: string;
}

/** What happened to a public enquiry -- the customer sees the same calm message either way. */
export type EnquiryOutcome = "created" | "merged" | "limit";

/**
 * A stage change decided against the lead's CURRENT row: the repository locks
 * the row, passes the current state to this callback (which applies the
 * domain rules and may throw), then writes what it returns -- so two people
 * changing the same lead at once can't both act on a stale stage.
 */
export type StatusChangeDecision = (current: LeadEntity) => {
  to: LeadStatus;
  followUpOn: string | null;
  lostReason: string | null;
  clearUrgent: boolean;
  note: string | null;
};

export interface LeadsRepository {
  list(query: LeadListQuery): Promise<LeadListResult>;
  summary(scope: LeadScope): Promise<LeadSummary>;
  /** Owner: designers who have leads, busiest first -- name search (contains) and a page. */
  designerStats(query: { q?: string; limit: number; offset: number }): Promise<DesignerStatsPage>;
  /** Owner: unassigned new leads. Designer: their leads waiting for "Received", plus their open urgent ones. */
  badgeCount(scope: LeadScope): Promise<number>;
  findById(id: string): Promise<LeadEntity | null>;
  listComments(leadId: string): Promise<LeadCommentEntity[]>;
  listEvents(leadId: string): Promise<LeadEventEntity[]>;
  /** Other leads from the same phone (newest first) -- the owner sees a returning customer. */
  findSamePhone(phone: string, excludeId: string, limit: number): Promise<Pick<LeadEntity, "id" | "leadNumber" | "status" | "createdAt">[]>;
  isActiveDesigner(userId: string): Promise<boolean>;

  createManual(data: NewManualLead): Promise<LeadEntity>;
  /** The public form: create, merge into the phone's lead within its 24h window, or decline -- atomically per phone. */
  submitEnquiry(input: EnquiryInput, now: Date): Promise<EnquiryOutcome>;
  /** Locks the row; `assertAssignable(current)` may throw. Sets status `assigned`. */
  assign(id: string, designerId: string, actorId: string, assertAssignable: (current: LeadEntity) => void, expectedVersion?: number): Promise<LeadEntity>;
  changeStatus(id: string, actorId: string, decide: StatusChangeDecision, expectedVersion?: number): Promise<LeadEntity>;
  addComment(leadId: string, authorId: string, body: string): Promise<LeadCommentEntity>;
}
