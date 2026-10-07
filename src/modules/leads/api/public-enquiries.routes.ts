import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { asyncHandler } from "../../../common/http/async-handler";
import { validateBody } from "../../../common/http/validate.middleware";
import { env } from "../../../config/env";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { ENQUIRY_MESSAGES } from "../domain/enquiry.rules";
import { publicEnquirySchema, type PublicEnquiryDto } from "./dto/leads.dto";
import { leadsService } from "./leads.routes";

/**
 * The ONLY unauthenticated write in the API: the public enquiry form.
 * Mounted at /api/v1/public with its own small JSON body limit (app.ts), ahead
 * of the global parser. Defences, outermost first:
 *   1. per-IP limit (5/hour) + an hourly ceiling for everyone (200) -- a flood
 *      can't swamp the leads list or the database;
 *   2. strict schema -- unknown fields rejected; name letters-only, phone a
 *      real Indian mobile, requirement plain text <= 1000 chars;
 *   3. honeypot + signed open-time token (too fast = a bot; tampered/expired = reload);
 *   4. Cloudflare Turnstile, when switched on;
 *   5. at most 2 enquiries per phone per 24 hours (the 2nd merges, marks urgent).
 * Parameterised SQL throughout (no string-built queries), and the response
 * never echoes data, ids or internals back.
 */
export const publicEnquiriesRouter = Router();

function limiter(windowMs: number, limit: number, keyGenerator?: (req: Request) => string) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (req: Request, res: Response) => {
      res.status(429).json({
        error: "Too many enquiries from this connection. Please try again later, or call us.",
        code: ERROR_CODES.RATE_LIMITED,
        requestId: typeof req.id === "string" ? req.id : undefined,
      });
    },
  });
}

const perIpSubmit = limiter(env.PUBLIC_ENQUIRY_RATE_LIMIT_WINDOW_MS, env.PUBLIC_ENQUIRY_RATE_LIMIT_MAX);
const everyoneSubmit = limiter(60 * 60 * 1000, env.PUBLIC_ENQUIRY_GLOBAL_MAX_PER_HOUR, () => "everyone");
// Opening the form is cheap but still bounded (a page refresh fetches a fresh token).
const perIpOpen = limiter(60 * 60 * 1000, 120);

/** Before showing the form: its signed open-time token and, if Turnstile is on, the site key. */
publicEnquiriesRouter.get("/enquiry-form", perIpOpen, (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(leadsService.publicFormConfig());
});

/** A customer's enquiry. Always a calm, generic reply (201 received / 200 already received). */
publicEnquiriesRouter.post(
  "/enquiries",
  perIpSubmit,
  everyoneSubmit,
  validateBody(publicEnquirySchema),
  asyncHandler(async (req, res) => {
    const { reply, stored } = await leadsService.submitPublicEnquiry(req.body as PublicEnquiryDto, { ip: req.ip });
    if (!stored && reply.result === "received") req.log.warn({ ip: req.ip }, "Public enquiry dropped as bot-like (honeypot or too fast)");
    res.status(reply.result === "received" ? 201 : 200).json(reply);
  }),
);

export { ENQUIRY_MESSAGES };
