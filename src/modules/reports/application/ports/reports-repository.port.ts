import type { ActivityCategory, StaffStatus, TrackedStaffRole } from "../../domain/staff-activity.rules";
import type { ActivityCounts, ActivityEventEntity, StaffWorkloadEntity } from "../../domain/staff-activity.entity";

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
  category: ActivityCategory;
  limit: number;
  offset: number;
}

/** What the Reports Application layer needs from persistence. Read-only. */
export interface ReportsRepositoryPort {
  /** One page of ACTIVE tracked staff with their workload facts -- filtered, counted and paged in the database. */
  getStaffWorkload(query: StaffWorkloadQuery): Promise<StaffWorkloadPage>;
  /** One page of one day's events in one category, newest first. */
  getActivityDay(query: ActivityDayQuery): Promise<ActivityEventEntity[]>;
  /** How many events each category holds on that day (one round trip). */
  getActivityCounts(day: string, timeZone: string): Promise<ActivityCounts>;
}
