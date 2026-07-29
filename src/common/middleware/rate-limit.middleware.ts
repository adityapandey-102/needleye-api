import rateLimit from "express-rate-limit";
import { env } from "../../config/env";
import { ERROR_CODES } from "../errors/error-codes";

/**
 * Brute-force protection for authentication endpoints only. Deliberately
 * scoped to `/auth/*` -- the rest of the API is behind a bearer token, so the
 * unauthenticated attack surface worth rate-limiting is the credential and
 * token endpoints (login, password reset, refresh, QR login, code exchange).
 *
 * In-memory store (express-rate-limit's default). This is a single-process
 * Modular Monolith at ~100 users, so a per-instance in-memory counter is
 * exactly right -- no Redis, no distributed coordination. Everything is
 * isolated in this one module: swapping to a shared store later (if this ever
 * runs multi-instance) is a one-line `store:` change here, with nothing else
 * in the app touched.
 */
export const authRateLimiter = rateLimit({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: "draft-7", // RateLimit-* response headers
  legacyHeaders: false,
  // Respond in the API's standard error shape (stable code + requestId) rather
  // than express-rate-limit's default plain-text body.
  handler: (req, res) => {
    res.status(429).json({
      error: "Too many attempts. Please wait a while and try again.",
      code: ERROR_CODES.RATE_LIMITED,
      requestId: typeof req.id === "string" ? req.id : undefined,
    });
  },
});
