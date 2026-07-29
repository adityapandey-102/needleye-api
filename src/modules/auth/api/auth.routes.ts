import { Router } from "express";
import { requireAuth } from "../../../common/middleware/auth.middleware";
import { authRateLimiter } from "../../../common/middleware/rate-limit.middleware";
import { asyncHandler } from "../../../common/http/async-handler";
import { validateBody } from "../../../common/http/validate.middleware";
import { AuthService } from "../application/auth.service";
import { DrizzleAuthRepository } from "../infrastructure/drizzle-auth.repository";
import { bootstrapDtoSchema, type BootstrapDto } from "./dto/bootstrap.dto";
import { loginDtoSchema, type LoginDto } from "./dto/login.dto";
import { refreshDtoSchema, type RefreshDto } from "./dto/refresh.dto";
import { passwordResetRequestDtoSchema, type PasswordResetRequestDto } from "./dto/password-reset-request.dto";
import { passwordUpdateDtoSchema, type PasswordUpdateDto } from "./dto/password-update.dto";
import { exchangeCodeDtoSchema, type ExchangeCodeDto } from "./dto/exchange-code.dto";
import { qrLoginDtoSchema, type QrLoginDto } from "./dto/qr-login.dto";
import { authProvider } from "../../../common/auth/supabase-auth-provider";

/** Composition root for the Auth module -- wires the concrete (Infrastructure) adapter into the Application service. */
const authService = new AuthService(new DrizzleAuthRepository(authProvider));

export const authRouter = Router();

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ profile: req.profile });
});

authRouter.get(
  "/bootstrap-status",
  asyncHandler(async (_req, res) => {
    res.json(await authService.getBootstrapStatus());
  }),
);

authRouter.post(
  "/bootstrap",
  authRateLimiter,
  validateBody(bootstrapDtoSchema),
  asyncHandler(async (req, res) => {
    await authService.bootstrap(req.body as BootstrapDto);
    res.status(201).json({ ok: true });
  }),
);

authRouter.post(
  "/login",
  authRateLimiter,
  validateBody(loginDtoSchema),
  asyncHandler(async (req, res) => {
    res.json(await authService.login(req.body as LoginDto));
  }),
);

authRouter.post(
  "/refresh",
  authRateLimiter,
  validateBody(refreshDtoSchema),
  asyncHandler(async (req, res) => {
    res.json(await authService.refresh(req.body as RefreshDto));
  }),
);

authRouter.post(
  "/logout",
  requireAuth,
  asyncHandler(async (req, res) => {
    await authService.logout(req.accessToken!);
    res.status(204).send();
  }),
);

authRouter.post(
  "/password-reset-request",
  authRateLimiter,
  validateBody(passwordResetRequestDtoSchema),
  asyncHandler(async (req, res) => {
    await authService.requestPasswordReset(req.body as PasswordResetRequestDto);
    // Always 204, whether or not the email matches an account -- never confirms existence.
    res.status(204).send();
  }),
);

authRouter.post(
  "/password-update",
  authRateLimiter,
  requireAuth,
  validateBody(passwordUpdateDtoSchema),
  asyncHandler(async (req, res) => {
    await authService.updatePassword(req.authUserId!, req.body as PasswordUpdateDto);
    res.status(204).send();
  }),
);

authRouter.post(
  "/exchange-code",
  authRateLimiter,
  validateBody(exchangeCodeDtoSchema),
  asyncHandler(async (req, res) => {
    res.json(await authService.exchangeCode(req.body as ExchangeCodeDto));
  }),
);

authRouter.post(
  "/qr-login",
  authRateLimiter,
  validateBody(qrLoginDtoSchema),
  asyncHandler(async (req, res) => {
    res.json(await authService.qrLogin(req.body as QrLoginDto));
  }),
);
