import { z } from "zod";
import {
  ACTIVITY_CATEGORIES,
  TRACKED_STAFF_ROLES,
  type ActivityCategory,
  type StaffStatus,
  type TrackedStaffRole,
} from "../../domain/staff-activity.rules";

/** A real calendar date in YYYY-MM-DD (rejects 2026-02-31). */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((value) => {
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }, "Not a real date");

export const ACTIVITY_PAGE_MAX = 100;
export const STAFF_PAGE_MAX = 50;

/** GET /reports/staff-activity?q=&role=&status=&limit=&offset= -- filtered and paged in the database. */
export const staffActivityQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((v) => (v ? v : undefined)),
  role: z.enum(TRACKED_STAFF_ROLES).optional(),
  status: z.enum(["working", "idle"]).optional(),
  limit: z.coerce.number().int().min(1).max(STAFF_PAGE_MAX).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type StaffActivityQuery = z.infer<typeof staffActivityQuerySchema>;

/** GET /reports/activity?day=&category=&limit=&offset= -- one day, one category, a page at a time. */
export const activityQuerySchema = z.object({
  day: isoDate,
  category: z.enum(ACTIVITY_CATEGORIES).default("orders"),
  limit: z.coerce.number().int().min(1).max(ACTIVITY_PAGE_MAX).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ActivityQuery = z.infer<typeof activityQuerySchema>;

export interface StaffActivityRowDto {
  id: string;
  fullName: string;
  role: TrackedStaffRole;
  status: StaffStatus;
  /** Undelivered orders that make them Working (see `windows`). */
  openOrders: number;
  lastWorkAt: string | null;
  lastSeenAt: string | null;
}

/** GET /reports/staff-activity */
export interface StaffActivityResponseDto {
  /** The look-back windows the statuses were computed with: designers in days, floor staff in hours. */
  windows: { designerDays: number; floorHours: number };
  /** Working / Idle across the search + role filters (ignores `status`) -- the summary tiles. */
  counts: { working: number; idle: number };
  /** This page. */
  staff: StaffActivityRowDto[];
  /** Rows matching every filter. */
  total: number;
  limit: number;
  offset: number;
}

/** GET /reports/activity-days -- the days the feed covers, newest first. */
export interface ActivityDaysResponseDto {
  timeZone: string;
  today: string;
  days: string[];
}

export interface ActivityEventDto {
  id: string;
  category: ActivityCategory;
  /** order.created, price.raise, stage.moved, payment.updated, lead.assigned, auth.login, ... */
  kind: string;
  at: string;
  actorName: string | null;
  actorRole: string | null;
  orderId: string | null;
  orderNumber: string | null;
  leadId: string | null;
  leadNumber: string | null;
  targetName: string | null;
  details: Record<string, unknown> | null;
}

/** GET /reports/activity */
export interface ActivityDayResponseDto {
  day: string;
  timeZone: string;
  category: ActivityCategory;
  /** Events per category on this day -- the tab counts. */
  counts: Record<ActivityCategory, number>;
  events: ActivityEventDto[];
  /** Events in this category on this day (= counts[category]). */
  total: number;
  limit: number;
  offset: number;
}
