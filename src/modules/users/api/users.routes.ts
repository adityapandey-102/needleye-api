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

usersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ users: await usersService.listUsers() });
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
