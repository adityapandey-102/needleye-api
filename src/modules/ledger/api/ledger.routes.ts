import { Router } from "express";
import { requireAuth } from "../../../common/middleware/auth.middleware";
import { requireCapability } from "../../../common/middleware/capability.middleware";
import { asyncHandler } from "../../../common/http/async-handler";
import { env } from "../../../config/env";
import { ledgerExportQuerySchema, ledgerMonthsQuerySchema } from "./dto/ledger.dto";
import { LedgerService } from "../application/ledger.service";
import { DrizzleLedgerRepository } from "../infrastructure/drizzle-ledger.repository";

/** Composition root for the Ledger module. */
const ledgerService = new LedgerService(new DrizzleLedgerRepository(), { timeZone: env.BUSINESS_TIMEZONE });

export const ledgerRouter = Router();

// The Revenue page's numbers: Owner and Accountant only.
ledgerRouter.use(requireAuth, requireCapability("reports:financial"));

/** This month's cards: total booked, paid so far, outstanding, cash collected. */
ledgerRouter.get(
  "/summary",
  asyncHandler(async (_req, res) => {
    res.json(await ledgerService.getSummary());
  }),
);

/** Calendar months of a range, newest first, paged -- with the range's totals. */
ledgerRouter.get(
  "/months",
  asyncHandler(async (req, res) => {
    res.json(await ledgerService.getMonths(ledgerMonthsQuerySchema.parse(req.query)));
  }),
);

/** Every month of a range (at most 240), unpaged -- the CSV / PDF export. */
ledgerRouter.get(
  "/months/export",
  asyncHandler(async (req, res) => {
    res.json(await ledgerService.getExport(ledgerExportQuerySchema.parse(req.query)));
  }),
);
