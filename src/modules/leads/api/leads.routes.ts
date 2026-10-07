import { createHmac } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import { requireAuth } from "../../../common/middleware/auth.middleware";
import { requireCapability } from "../../../common/middleware/capability.middleware";
import { asyncHandler } from "../../../common/http/async-handler";
import { validateBody } from "../../../common/http/validate.middleware";
import { env } from "../../../config/env";
import { LeadsService, type LeadsCaller } from "../application/leads.service";
import { DrizzleLeadsRepository } from "../infrastructure/drizzle-leads.repository";
import { CloudflareTurnstile } from "../infrastructure/cloudflare-turnstile";
import {
  addLeadCommentSchema,
  assignLeadSchema,
  changeLeadStatusSchema,
  createLeadSchema,
  designerStatsQuerySchema,
  listLeadsQuerySchema,
  type AddLeadCommentDto,
  type AssignLeadDto,
  type ChangeLeadStatusDto,
  type CreateLeadDto,
} from "./dto/leads.dto";

/**
 * Composition root for the Leads module. The form secret defaults to a value
 * derived from the service-role key (stable, never sent anywhere); Turnstile is
 * wired in only when switched on.
 */
const formSecret = env.PUBLIC_FORM_SECRET ?? createHmac("sha256", env.SUPABASE_SERVICE_ROLE_KEY).update("needleye-public-enquiry-form").digest("hex");
export const leadsService = new LeadsService(
  new DrizzleLeadsRepository(),
  {
    timeZone: env.BUSINESS_TIMEZONE,
    publicForm: { formSecret, turnstileSiteKey: env.TURNSTILE_ENABLED ? env.TURNSTILE_SITE_KEY : null },
  },
  env.TURNSTILE_ENABLED ? new CloudflareTurnstile(env.TURNSTILE_SECRET_KEY) : null,
);

export const leadsRouter = Router();

// Owner (all leads) and designers (their own); everyone else gets 403 here.
leadsRouter.use(requireAuth, requireCapability("leads:read"));

const callerOf = (req: Request): LeadsCaller => ({ userId: req.authUserId!, role: req.profile!.role });
const leadId = (req: Request) => z.string().uuid().parse(req.params.id);

/** The paged, searched list (stage / urgent / designer filters). */
leadsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(await leadsService.list(callerOf(req), listLeadsQuerySchema.parse(req.query)));
  }),
);

/** Counts per stage + urgent -- the Leads dashboard tiles. */
leadsRouter.get(
  "/summary",
  asyncHandler(async (req, res) => {
    res.json(await leadsService.summary(callerOf(req)));
  }),
);

/** Owner: the Designers table -- name search + page (never the whole team at once). Before /:id. */
leadsRouter.get(
  "/designers",
  requireCapability("leads:manage"),
  asyncHandler(async (req, res) => {
    res.json(await leadsService.designerStats(callerOf(req), designerStatsQuerySchema.parse(req.query)));
  }),
);

/** The red badge: owner = unassigned new leads; designer = leads waiting for "Received" + their urgent ones. */
leadsRouter.get(
  "/badge",
  asyncHandler(async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(await leadsService.badge(callerOf(req)));
  }),
);

/** The owner's manual lead (walk-in, phone call, Instagram, ...). */
leadsRouter.post(
  "/",
  requireCapability("leads:manage"),
  validateBody(createLeadSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ lead: await leadsService.createManual(callerOf(req), req.body as CreateLeadDto) });
  }),
);

/** One lead: details, comments, history, and the actions the caller may take. */
leadsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json(await leadsService.detail(callerOf(req), leadId(req)));
  }),
);

leadsRouter.patch(
  "/:id/assign",
  requireCapability("leads:manage"),
  validateBody(assignLeadSchema),
  asyncHandler(async (req, res) => {
    res.json({ lead: await leadsService.assign(callerOf(req), leadId(req), req.body as AssignLeadDto) });
  }),
);

leadsRouter.patch(
  "/:id/status",
  validateBody(changeLeadStatusSchema),
  asyncHandler(async (req, res) => {
    res.json({ lead: await leadsService.changeStatus(callerOf(req), leadId(req), req.body as ChangeLeadStatusDto) });
  }),
);

leadsRouter.post(
  "/:id/comments",
  validateBody(addLeadCommentSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ comment: await leadsService.addComment(callerOf(req), leadId(req), req.body as AddLeadCommentDto) });
  }),
);
