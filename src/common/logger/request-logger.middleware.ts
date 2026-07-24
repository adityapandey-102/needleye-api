import pinoHttp from "pino-http";
import { randomUUID } from "node:crypto";
import { logger } from "./logger";

/**
 * Logs every request/response (method, path, status, duration) and attaches
 * `req.log` -- a child logger already carrying the request id -- so any
 * handler or middleware can log with request context for free, without
 * threading a logger through every function signature.
 *
 * `authorization` is redacted: the bearer token must never end up in a log
 * line, in dev or prod.
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
    paths: ["req.headers.authorization", "res.headers.authorization"],
    censor: "[redacted]",
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return "error";
    if (res.statusCode >= 400) return "warn";
    return "info";
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} -> ${res.statusCode}`,
  customErrorMessage: (req, res, err) => `${req.method} ${req.url} -> ${res.statusCode} (${err.message})`,
});
