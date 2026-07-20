import cors from "cors";
import express from "express";
import { env } from "./config/env";
import { authRouter } from "./modules/auth/auth.routes";
import { usersRouter } from "./modules/users/users.routes";
import { ordersRouter } from "./modules/orders/orders.routes";
import { teamMembersRouter } from "./modules/team-members/team-members.routes";
import { errorHandler, notFoundHandler } from "./common/middleware/error.middleware";

/**
 * Composition root: builds the Express app and mounts every module's
 * router. Each module wires its own controller/service/repository/mapper
 * internally (see e.g. modules/orders/orders.routes.ts); this file only
 * knows about the resulting routers, never about a module's internals.
 */
export function createApp() {
  const app = express();

  app.use(cors({ origin: env.CORS_ALLOWED_ORIGIN, credentials: true }));
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Payments (Phase 3) and order status transitions (Phase 4) mount here too.
  const apiV1 = express.Router();
  apiV1.use("/auth", authRouter);
  apiV1.use("/users", usersRouter);
  apiV1.use("/orders", ordersRouter);
  apiV1.use("/team-members", teamMembersRouter);
  app.use("/api/v1", apiV1);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
