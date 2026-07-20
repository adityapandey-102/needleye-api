import { Router } from "express";
import { requireAuth } from "../../common/middleware/auth.middleware";
import { asyncHandler } from "../../common/http/async-handler";
import { validateBody } from "../../common/http/validate.middleware";
import { AuthService } from "./auth.service";
import { SupabaseAuthRepository } from "./auth.repository";
import { bootstrapDtoSchema } from "./dto/bootstrap.dto";

/** Composition root for the Auth module -- wires the concrete repository into the service. */
const authService = new AuthService(new SupabaseAuthRepository());

export const authRouter = Router();

authRouter.get(
  "/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ profile: req.profile });
  }),
);

authRouter.get(
  "/bootstrap-status",
  asyncHandler(async (_req, res) => {
    res.json(await authService.getBootstrapStatus());
  }),
);

authRouter.post(
  "/bootstrap",
  validateBody(bootstrapDtoSchema),
  asyncHandler(async (req, res) => {
    await authService.bootstrap(req.body);
    res.status(201).json({ ok: true });
  }),
);
