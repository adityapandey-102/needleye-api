/**
 * Response for GET /orders/staff-report -- one designer/master-tailor's
 * workload report for a month (owner_manager only, `reports:staff`). The
 * summary is the current status of the orders they BOOKED in that month (the
 * month's cohort); `weekly` is that month's booked/completed activity per week.
 */
export interface StaffReportSummaryDto {
  booked: number;
  active: number;
  inProduction: number;
  completed: number;
  overdue: number;
  urgent: number;
  paymentPendingCount: number;
  paymentPendingAmount: number;
}

export interface StaffWeeklyPointDto {
  weekStart: string;
  booked: number;
  completed: number;
}

export interface StaffReportResponseDto {
  staff: { id: string; fullName: string; role: "designer" | "master_tailor" };
  summary: StaffReportSummaryDto;
  /** The selected month's weeks (Monday-started, oldest first, zero-filled). */
  weekly: StaffWeeklyPointDto[];
  /** The month the weekly breakdown covers, `YYYY-MM` (echoes the request; defaults to the current month). */
  month: string;
}
