import type { StaffStatus, TrackedStaffRole } from "../../domain/staff-activity.rules";
import type { ActivityEventEntity, StaffWorkloadEntity } from "../../domain/staff-activity.entity";

export interface StaffWorkloadQuery {
  designerWindowDays: number;
  floorWindowDays: number;
  /** Case-insensitive name contains. */
  search?: string;
  role?: TrackedStaffRole;
  status?: StaffStatus;
  limit: number;
  offset: number;
}

export interface StaffWorkloadPage {
  /** This page, Working first, then role, then most orders in hand, then name. */
  rows: StaffWorkloadEntity[];
  /** Rows matching every filter (for the pager). */
  total: number;
  /** Working / Idle across the search + role filters, ignoring the status filter (the summary tiles). */
  counts: { working: number; idle: number };
}

export interface ActivityDayQuery {
  /** YYYY-MM-DD, a day in `timeZone`. */
  day: string;
  timeZone: string;
  /** Action prefixes left out of the feed (e.g. "payment."). */
  excludePrefixes: readonly string[];
  limit: number;
  offset: number;
}

/** What the Reports Application layer needs from persistence. Read-only. */
export interface ReportsRepositoryPort {
  /** One page of ACTIVE tracked staff with their workload facts -- filtered, counted and paged in the database. */
  getStaffWorkload(query: StaffWorkloadQuery): Promise<StaffWorkloadPage>;
  /** One day's audit events, newest first, plus that day's total. */
  getActivityDay(query: ActivityDayQuery): Promise<{ events: ActivityEventEntity[]; total: number }>;
}
