import cors from "cors";
import express from "express";
import { env } from "./config/env";
import { authRouter } from "./features/auth/auth.routes";
import { usersRouter } from "./features/users/users.routes";
import { ordersRouter } from "./features/orders/orders.routes";
import { teamMembersRouter } from "./features/team-members/teamMembers.routes";
import { errorHandler, notFoundHandler } from "./shared/middleware/errorHandler";

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
