import pinoHttp from "pino-http";
import { randomUUID } from "node:crypto";
import { logger } from "./logger";

/**
 * Logs every request/response with a consistent shape -- method, path,
 * status, duration (pino-http's `responseTime`), request id, and (once
 * authenticated) the caller's user id and role. Attaches `req.log`, a child
 * logger already carrying the request id, so any handler/middleware logs
 * with request context for free without threading a logger everywhere.
 *
 * Sensitive material is redacted, in dev and prod alike: the bearer token
 * (`authorization`) and any cookies -- these must never reach a log line.
 */
export const requestLogger = pinoHttp({
  logger,
  genReqId: (req, res) => {
    const existing = req.headers["x-request-id"];
    const id = typeof existing === "string" ? existing : randomUUID();
    res.setHeader("x-request-id", id);
    return id;
  },
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers.authorization",
      'res.headers["set-cookie"]',
    ],
    censor: "[redacted]",
  },
  // Identity of the caller, added to every request log once requireAuth has
  // run. `req.profile` is populated before the handler, so it's present by
  // the time this fires at response finish (absent on unauthenticated routes).
  // pino-http types `req` as the raw IncomingMessage, so reach the Express
  // augmentation (auth.middleware.ts's `Request.profile`) via a narrow cast.
  customProps: (req) => {
    const profile = (req as { profile?: { id: string; role: string } }).profile;
    return { userId: profile?.id, role: profile?.role };
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode}`,
  customErrorMessage: (req, res, err) => `${req.method} ${req.url} -> ${res.statusCode} (${err.message})`,
});
