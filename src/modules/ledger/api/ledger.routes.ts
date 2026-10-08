import { Router } from "express";
import { requireAuth } from "../../../common/middleware/auth.middleware";
import { requireCapability } from "../../../common/middleware/capability.middleware";
import { asyncHandler } from "../../../common/http/async-handler";
import { validateBody } from "../../../common/http/validate.middleware";
import { env } from "../../../config/env";
import { ledgerExportQuerySchema, ledgerMonthsQuerySchema, reopenMonthSchema, type ReopenMonthBody } from "./dto/ledger.dto";
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

/** Calendar months of a range, newest first, paged -- with the range's totals and each month's books. */
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

/** A month's books: its figures now, and every close (with the figures it locked) and reopen. */
ledgerRouter.get(
  "/months/:month/closings",
  asyncHandler(async (req, res) => {
    res.json(await ledgerService.getClosings(req.params.month!));
  }),
);

/** Close a finished month's books -- Owner and Accountant. Payments dated in it are then locked. */
ledgerRouter.post(
  "/months/:month/close",
  requireCapability("ledger:close"),
  asyncHandler(async (req, res) => {
    res.status(201).json({ closing: await ledgerService.closeMonth(req.params.month!, req.authUserId!) });
  }),
);

/** Reopen a closed month -- Owner only, with a reason. */
ledgerRouter.post(
  "/months/:month/reopen",
  requireCapability("ledger:reopen"),
  validateBody(reopenMonthSchema),
  asyncHandler(async (req, res) => {
    const { reason } = req.body as ReopenMonthBody;
    res.status(201).json({ closing: await ledgerService.reopenMonth(req.params.month!, req.authUserId!, reason) });
  }),
);

/** The latest check of the register against the receipts, and whether the nightly one is on schedule. */
ledgerRouter.get(
  "/reconciliations/latest",
  asyncHandler(async (_req, res) => {
    res.json(await ledgerService.getVerification());
  }),
);

/** "Verify now": run the check -- the same one the nightly job runs. 409 while another is running. */
ledgerRouter.post(
  "/reconciliations",
  asyncHandler(async (req, res) => {
    res.status(201).json(await ledgerService.verifyNow(req.authUserId!));
  }),
);
