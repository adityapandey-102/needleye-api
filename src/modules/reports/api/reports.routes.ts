import { Router } from "express";
import { requireAuth } from "../../../common/middleware/auth.middleware";
import { requireCapability } from "../../../common/middleware/capability.middleware";
import { asyncHandler } from "../../../common/http/async-handler";
import { env } from "../../../config/env";
import { activityQuerySchema, staffActivityQuerySchema } from "./dto/reports.dto";
import { ReportsService } from "../application/reports.service";
import { DrizzleReportsRepository } from "../infrastructure/drizzle-reports.repository";

/** Composition root for the Reports module. */
const reportsService = new ReportsService(new DrizzleReportsRepository(), { timeZone: env.BUSINESS_TIMEZONE });

export const reportsRouter = Router();

// The whole module is the owner's view of staff: owner_manager only.
reportsRouter.use(requireAuth, requireCapability("reports:staff"));

/**
 * Working / Idle for active designers, master tailors, production managers and
 * workers -- searched (?q=), filtered (?role=, ?status=) and paged (?limit=,
 * ?offset=, max 50) in the database. Also backs the Staff Report's person
 * picker (?role=designer / master_tailor).
 */
reportsRouter.get(
  "/staff-activity",
  asyncHandler(async (req, res) => {
    res.json(await reportsService.getStaffActivity(staffActivityQuerySchema.parse(req.query)));
  }),
);

/** The 7 days the activity feed covers (in the shop's timezone) -- no data, just the day list. */
reportsRouter.get("/activity-days", (_req, res) => {
  res.json(reportsService.getActivityDays());
});

/** One day's activity (payment events excluded), paginated; loaded per day, on demand. */
reportsRouter.get(
  "/activity",
  asyncHandler(async (req, res) => {
    // Strict parse: a malformed day is a 400, never silently "today".
    res.json(await reportsService.getActivityDay(activityQuerySchema.parse(req.query)));
  }),
);
