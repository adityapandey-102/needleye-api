import { Router } from "express";
import { requireAuth } from "../../../common/middleware/auth.middleware";
import { requireCapability } from "../../../common/middleware/capability.middleware";
import { asyncHandler } from "../../../common/http/async-handler";
import { validateBody } from "../../../common/http/validate.middleware";
import { createUserDtoSchema, type CreateUserDto } from "./dto/create-user.dto";
import { updateUserDtoSchema, type UpdateUserDto } from "./dto/update-user.dto";
import { UsersService } from "../application/users.service";
import { DrizzleUsersRepository } from "../infrastructure/drizzle-users.repository";
import { authProvider } from "../../../common/auth/supabase-auth-provider";

/** Composition root for the Users module -- wires the concrete (Infrastructure) adapter into the Application service. */
const usersService = new UsersService(new DrizzleUsersRepository(authProvider));

export const usersRouter = Router();

usersRouter.use(requireAuth, requireCapability("users:manage"));

/** Clamp to a sane page window -- same bounds as the Orders list. */
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

usersRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const { search, limit, offset } = req.query;
    const parsedLimit = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    const parsedOffset = Math.max(Number(offset) || 0, 0);
    const result = await usersService.listUsers(
      { search: typeof search === "string" ? search : undefined },
      { limit: parsedLimit, offset: parsedOffset },
    );
    res.json(result);
  }),
);

usersRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    res.json({ user: await usersService.getUser(req.params.id!) });
  }),
);

usersRouter.post(
  "/",
  validateBody(createUserDtoSchema),
  asyncHandler(async (req, res) => {
    const result = await usersService.createUser(req.body as CreateUserDto);
    res.status(201).json(result);
  }),
);

usersRouter.post(
  "/:id/generate-password",
  asyncHandler(async (req, res) => {
    const result = await usersService.generatePassword(req.params.id!);
    res.status(201).json(result);
  }),
);

usersRouter.post(
  "/:id/qr-token",
  asyncHandler(async (req, res) => {
    const result = await usersService.generateQrToken(req.params.id!);
    res.status(201).json(result);
  }),
);

usersRouter.patch(
  "/:id",
  validateBody(updateUserDtoSchema),
  asyncHandler(async (req, res) => {
    await usersService.updateUser(req.params.id!, req.body as UpdateUserDto);
    res.status(204).send();
  }),
);

usersRouter.post(
  "/:id/deactivate",
  asyncHandler(async (req, res) => {
    await usersService.deactivateUser(req.params.id!, req.authUserId!);
    res.status(204).send();
  }),
);

usersRouter.post(
  "/:id/reactivate",
  asyncHandler(async (req, res) => {
    await usersService.reactivateUser(req.params.id!);
    res.status(204).send();
  }),
);
