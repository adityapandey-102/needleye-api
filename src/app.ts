import cors from "cors";
import express from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import { sql } from "drizzle-orm";
import { env } from "./config/env";
import { db } from "./common/database/drizzle-client";
import { describeDbError } from "./common/database/db-logging";
import { logger } from "./common/logger/logger";
import { requestLogger } from "./common/logger/request-logger.middleware";
import { requestContextMiddleware } from "./common/context/request-context.middleware";
import { authRouter } from "./modules/auth/api/auth.routes";
import { usersRouter } from "./modules/users/api/users.routes";
import { ordersRouter } from "./modules/orders/api/orders.routes";
import { paymentsRouter } from "./modules/payments/api/payments.routes";
import { teamMembersRouter } from "./modules/team-members/api/team-members.routes";
import { errorHandler, notFoundHandler } from "./common/middleware/error.middleware";
import { openApiDocument } from "./docs/openapi";

/** Turns the TRUST_PROXY env string into what Express's `trust proxy` expects:
 *  a boolean, a hop count, or a preset/subnet string (e.g. "loopback"). */
function parseTrustProxy(value: string): boolean | number | string {
  if (value === "false") return false;
  if (value === "true") return true;
  const n = Number(value);
  return Number.isInteger(n) && value.trim() !== "" ? n : value;
}

/**
 * Composition root: builds the Express app and mounts every module's
 * router. Each module wires its own controller/service/repository/mapper
 * internally (see e.g. modules/orders/orders.routes.ts); this file only
 * knows about the resulting routers, never about a module's internals.
 */
export function createApp() {
  const app = express();

  // The API sits behind a proxy that sets X-Forwarded-For: the Next.js session
  // proxy in dev (over loopback), and a reverse proxy (Railway/Render/nginx) in
  // prod. Express must be told how far to trust XFF so the rate limiter keys on
  // the real client IP -- otherwise express-rate-limit throws when it sees an
  // untrusted XFF. Configured via TRUST_PROXY (default "loopback"): a hop count,
  // a preset like "loopback", or "false" to disable. See config/env.ts.
  app.set("trust proxy", parseTrustProxy(env.TRUST_PROXY));

  app.use(requestLogger);
  // Must come right after the request logger: it reads req.id (set above) so
  // the request-scoped context's id matches the logged req/res id.
  app.use(requestContextMiddleware);

  // Secure HTTP headers (HSTS, no-sniff, frameguard, hidden X-Powered-By,
  // etc). CSP is off globally -- this is a pure JSON API with no HTML views
  // of its own except /api-docs (Swagger UI), which needs inline
  // style/script that a default CSP would block; a same-origin-only CSP
  // for one internal documentation page isn't worth the complexity at this
  // app's scale/threat model (an internal LOB tool, not a public site).
  app.use(helmet({ contentSecurityPolicy: false }));

  // No `credentials: true` -- the API is stateless and bearer-token-only, it never
  // reads or sets cookies, so cross-origin requests never need to carry them
  // (this is also why CSRF protection doesn't apply here -- CSRF exploits
  // ambient cookie-based auth, which this API never has).
  //
  // CORS_ALLOWED_ORIGIN may be a single origin or a comma-separated list, so a
  // dev machine can allow both http://localhost:3000 and its LAN IP (phone
  // testing), or a prod deploy can allow a primary + preview domain. An exact
  // allow-list -- never a wildcard.
  const allowedOrigins = env.CORS_ALLOWED_ORIGIN.split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  app.use(cors({ origin: allowedOrigins }));
  app.use(express.json());

  // Liveness: is the process up and serving? No dependencies checked -- an
  // orchestrator uses this to decide whether to restart the container.
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Readiness: can the process actually serve traffic (DB reachable)? Returns
  // 503 if the DB check fails, so a load balancer stops routing to an
  // instance whose database is down instead of sending it doomed requests.
  app.get("/health/ready", (_req, res) => {
    void db
      .execute(sql`select 1`)
      .then(() => res.json({ status: "ready" }))
      .catch((err: unknown) => {
        // Previously silent -- a DB-unreachable readiness probe now leaves a
        // trace, so "the app is up but not serving" is diagnosable.
        logger.error({ db: describeDbError(err) ?? { message: err instanceof Error ? err.message : String(err) } }, "Readiness check failed -- database unreachable");
        res.status(503).json({ status: "not_ready", reason: "database_unreachable" });
      });
  });

  // Source of truth: openapi.yaml (repo root). Keep it updated alongside any
  // route change -- see README's "Keeping this documentation in sync".
  app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openApiDocument));

  // Order status transitions (Phase 4) mount here too.
  const apiV1 = express.Router();
  apiV1.use("/auth", authRouter);
  apiV1.use("/users", usersRouter);
  // Mounted before /orders so it's unambiguous which router owns this path
  // (Express would fall through to /orders correctly either way, since
  // ordersRouter has no matching route here, but this reads clearer).
  apiV1.use("/orders/:orderId/payments", paymentsRouter);
  apiV1.use("/orders", ordersRouter);
  apiV1.use("/team-members", teamMembersRouter);
  app.use("/api/v1", apiV1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
