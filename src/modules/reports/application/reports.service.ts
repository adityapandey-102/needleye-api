import type { ReportsRepositoryPort } from "./ports/reports-repository.port";
import {
  activityDays,
  assertActivityDay,
  businessToday,
  DESIGNER_WORKING_WINDOW_DAYS,
  FLOOR_WORKING_WINDOW_HOURS,
  staffStatus,
} from "../domain/staff-activity.rules";
import type {
  ActivityDayResponseDto,
  ActivityDaysResponseDto,
  ActivityQuery,
  StaffActivityQuery,
  StaffActivityResponseDto,
} from "../api/dto/reports.dto";

export interface ReportsServiceOptions {
  /** The shop's IANA timezone -- where each activity day begins and ends. */
  timeZone: string;
  /** Injectable clock, so "today" is testable. */
  now?: () => Date;
}

/**
 * The owner's Reports page (route-gated by reports:staff -- owner_manager
 * only): who is Working vs Idle, and what happened on each of the last 7 days.
 */
export class ReportsService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: ReportsRepositoryPort,
    private readonly options: ReportsServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async getStaffActivity(query: StaffActivityQuery): Promise<StaffActivityResponseDto> {
    const page = await this.repository.getStaffWorkload({
      designerWindowDays: DESIGNER_WORKING_WINDOW_DAYS,
      floorWindowHours: FLOOR_WORKING_WINDOW_HOURS,
      search: query.q,
      role: query.role,
      status: query.status,
      limit: query.limit,
      offset: query.offset,
    });
    return {
      windows: { designerDays: DESIGNER_WORKING_WINDOW_DAYS, floorHours: FLOOR_WORKING_WINDOW_HOURS },
      counts: page.counts,
      staff: page.rows.map((r) => ({ ...r, status: staffStatus(r.openOrders) })),
      total: page.total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  getActivityDays(): ActivityDaysResponseDto {
    const today = businessToday(this.now(), this.options.timeZone);
    return { timeZone: this.options.timeZone, today, days: activityDays(today) };
  }

  /** One page of one category of one day, plus every category's count for that day (the tabs). */
  async getActivityDay(query: ActivityQuery): Promise<ActivityDayResponseDto> {
    assertActivityDay(query.day, businessToday(this.now(), this.options.timeZone));
    const timeZone = this.options.timeZone;
    const [events, counts] = await Promise.all([
      this.repository.getActivityDay({ day: query.day, timeZone, category: query.category, limit: query.limit, offset: query.offset }),
      this.repository.getActivityCounts(query.day, timeZone),
    ]);
    return {
      day: query.day,
      timeZone,
      category: query.category,
      counts,
      events,
      total: counts[query.category],
      limit: query.limit,
      offset: query.offset,
    };
  }
}
