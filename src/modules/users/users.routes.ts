import { Router } from "express";
import { requireAuth } from "../../common/middleware/auth.middleware";
import { requireCapability } from "../../common/middleware/capability.middleware";
import { asyncHandler } from "../../common/http/async-handler";
import { validateBody } from "../../common/http/validate.middleware";
import { inviteUserDtoSchema } from "./dto/invite-user.dto";
import { updateUserDtoSchema } from "./dto/update-user.dto";
import { UsersService } from "./users.service";
import { SupabaseUsersRepository } from "./users.repository";
import { UsersMapper } from "./users.mapper";

/** Composition root for the Users module. */
const usersService = new UsersService(new SupabaseUsersRepository(), new UsersMapper());

export const usersRouter = Router();

usersRouter.use(requireAuth, requireCapability("users:manage"));

usersRouter.get(
  "/",
  asyncHandler(async (_req, res) => {
    res.json({ users: await usersService.listUsers() });
  }),
);

usersRouter.post(
  "/invite",
  validateBody(inviteUserDtoSchema),
  asyncHandler(async (req, res) => {
    const result = await usersService.inviteUser(req.body);
    res.status(201).json(result);
  }),
);

usersRouter.patch(
  "/:id",
  validateBody(updateUserDtoSchema),
  asyncHandler(async (req, res) => {
    await usersService.updateUser(req.params.id!, req.body);
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
