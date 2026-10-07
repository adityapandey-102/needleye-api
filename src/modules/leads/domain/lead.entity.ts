/**
 * Leads domain types. A lead is a customer enquiry -- from the public enquiry
 * form or added by the owner -- that a designer works until it becomes an order
 * (converted) or is closed (lost / discarded). See docs/adr/0007.
 */

export const LEAD_STATUSES = ["new", "assigned", "unattended", "attended", "follow_up", "converted", "lost", "discarded"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

/** Stages that are finished: nothing more happens unless the owner reopens one (lost / discarded). */
export const CLOSED_LEAD_STATUSES: readonly LeadStatus[] = ["converted", "lost", "discarded"];

/** Where a lead came from: the public form, or the owner's manual entry (which channel). */
export const LEAD_SOURCES = ["public_form", "walk_in", "phone_call", "instagram", "whatsapp", "referral", "other"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];
/** The sources the owner can pick on the manual form (public_form is only ever set by the form itself). */
export const MANUAL_LEAD_SOURCES = LEAD_SOURCES.filter((s): s is Exclude<LeadSource, "public_form"> => s !== "public_form");

export type LeadEventKind = "created" | "enquiry_merged" | "assigned" | "status_changed" | "converted";

export interface LeadEntity {
  id: string;
  leadNumber: string;
  customerName: string;
  phone: string;
  requirement: string;
  source: LeadSource;
  status: LeadStatus;
  assignedTo: string | null;
  assignedToName: string | null;
  assignedAt: string | null;
  urgent: boolean;
  enquiryCount: number;
  firstEnquiryAt: string;
  lastEnquiryAt: string;
  followUpOn: string | null;
  lostReason: string | null;
  convertedOrderId: string | null;
  convertedOrderNumber: string | null;
  createdBy: string | null;
  createdByName: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface LeadCommentEntity {
  id: string;
  leadId: string;
  authorId: string | null;
  authorName: string | null;
  body: string;
  createdAt: string;
}

export interface LeadEventEntity {
  id: string;
  leadId: string;
  actorId: string | null;
  actorName: string | null;
  kind: LeadEventKind;
  fromStatus: LeadStatus | null;
  toStatus: LeadStatus | null;
  assignedTo: string | null;
  assignedToName: string | null;
  note: string | null;
  createdAt: string;
}
