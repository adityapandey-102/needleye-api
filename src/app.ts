import cors from "cors";
import express from "express";
import swaggerUi from "swagger-ui-express";
import { env } from "./config/env";
import { requestLogger } from "./common/logger/request-logger.middleware";
import { authRouter } from "./modules/auth/api/auth.routes";
import { usersRouter } from "./modules/users/api/users.routes";
import { ordersRouter } from "./modules/orders/api/orders.routes";
import { paymentsRouter } from "./modules/payments/api/payments.routes";
import { teamMembersRouter } from "./modules/team-members/api/team-members.routes";
import { errorHandler, notFoundHandler } from "./common/middleware/error.middleware";
import { openApiDocument } from "./docs/openapi";

/**
 * Composition root: builds the Express app and mounts every module's
 * router. Each module wires its own controller/service/repository/mapper
 * internally (see e.g. modules/orders/orders.routes.ts); this file only
 * knows about the resulting routers, never about a module's internals.
 */
export function createApp() {
  const app = express();

  app.use(requestLogger);

  // No `credentials: true` -- the API is stateless and bearer-token-only, it never
  // reads or sets cookies, so cross-origin requests never need to carry them.
  app.use(cors({ origin: env.CORS_ALLOWED_ORIGIN }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
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
