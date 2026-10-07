import { z } from "zod";
import { ENQUIRY_LIMITS, normalizeFreeText, normalizeIndianMobile, normalizePersonName } from "../../domain/enquiry.rules";
import { LEAD_STATUSES, MANUAL_LEAD_SOURCES } from "../../domain/lead.entity";

/** A real calendar date in YYYY-MM-DD (rejects 2026-02-31). */
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((value) => {
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }, "Not a real date");

/** The customer's name -- letters (any script), spaces, . ' - only. */
const personName = z
  .string()
  .max(200)
  .transform((v, ctx) => {
    const name = normalizePersonName(v);
    if (!name) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Enter a name of ${ENQUIRY_LIMITS.nameMin}-${ENQUIRY_LIMITS.nameMax} letters` });
      return z.NEVER;
    }
    return name;
  });

/** A 10-digit Indian mobile number in any common format, stored as 10 digits. */
const mobile = z
  .string()
  .max(30)
  .transform((v, ctx) => {
    const phone = normalizeIndianMobile(v);
    if (!phone) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Enter a valid 10-digit mobile number" });
      return z.NEVER;
    }
    return phone;
  });

/** Plain text up to `max` characters after tidying (control characters removed). */
const freeText = (max: number, { required = false } = {}) =>
  z
    .string()
    .max(max * 2)
    .transform((v, ctx) => {
      const text = normalizeFreeText(v);
      if (text.length > max) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Keep it under ${max} characters` });
        return z.NEVER;
      }
      if (required && text.length === 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "This can't be empty" });
        return z.NEVER;
      }
      return text;
    });

export const LEADS_PAGE_MAX = 50;

/** GET /leads -- filtered, searched and paged in the database. */
export const listLeadsQuerySchema = z.object({
  status: z.enum([...LEAD_STATUSES, "open"]).optional(),
  urgent: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  q: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((v) => (v ? v : undefined)),
  assignedTo: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(LEADS_PAGE_MAX).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListLeadsQuery = z.infer<typeof listLeadsQuerySchema>;

/** GET /leads/designers -- the owner's Designers table, searched (debounced in the web) and paged. */
export const DESIGNER_STATS_PAGE_MAX = 50;
export const designerStatsQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .max(80)
    .optional()
    .transform((v) => (v ? v : undefined)),
  limit: z.coerce.number().int().min(1).max(DESIGNER_STATS_PAGE_MAX).default(10),
  offset: z.coerce.number().int().min(0).default(0),
});
export type DesignerStatsQuery = z.infer<typeof designerStatsQuerySchema>;

/** POST /leads -- the owner's manual lead (walk-in, phone call, Instagram, ...). */
export const createLeadSchema = z
  .object({
    customerName: personName,
    phone: mobile,
    requirement: freeText(ENQUIRY_LIMITS.requirementMax),
    source: z.enum(MANUAL_LEAD_SOURCES as [string, ...string[]]),
    assignTo: z.string().uuid().nullable().optional(),
  })
  .strict();
export type CreateLeadDto = z.infer<typeof createLeadSchema>;

/** PATCH /leads/:id/assign */
export const assignLeadSchema = z.object({ designerId: z.string().uuid(), version: z.number().int().min(1).optional() }).strict();
export type AssignLeadDto = z.infer<typeof assignLeadSchema>;

/** PATCH /leads/:id/status */
export const changeLeadStatusSchema = z
  .object({
    status: z.enum(LEAD_STATUSES),
    followUpOn: isoDate.nullable().optional(),
    lostReason: freeText(300).nullable().optional(),
    version: z.number().int().min(1).optional(),
  })
  .strict();
export type ChangeLeadStatusDto = z.infer<typeof changeLeadStatusSchema>;

/** POST /leads/:id/comments */
export const addLeadCommentSchema = z.object({ body: freeText(2000, { required: true }) }).strict();
export type AddLeadCommentDto = z.infer<typeof addLeadCommentSchema>;

/**
 * POST /public/enquiries -- the open form. Strict: an unexpected field is a 400.
 * `website` is the honeypot (hidden from people, filled by bots); `formToken`
 * is the signed open-time from GET /public/enquiry-form; `turnstileToken` is
 * only checked when Turnstile is switched on.
 */
export const publicEnquirySchema = z
  .object({
    name: personName,
    phone: mobile,
    requirement: freeText(ENQUIRY_LIMITS.requirementMax, { required: true }),
    formToken: z.string().max(128),
    website: z.string().max(200).optional(),
    turnstileToken: z.string().max(2048).optional(),
  })
  .strict();
export type PublicEnquiryDto = z.infer<typeof publicEnquirySchema>;
