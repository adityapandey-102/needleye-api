import { BadRequestError } from "../../common/errors/app-error";
import type { Role } from "../../domain";
import type { UsersRepository, ProfileUpdate } from "./users.repository";
import type { UsersMapper } from "./users.mapper";
import type { UserDto } from "./dto/user.dto";
import type { InviteUserDto } from "./dto/invite-user.dto";
import type { UpdateUserDto } from "./dto/update-user.dto";

export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepository,
    private readonly mapper: UsersMapper,
  ) {}

  async listUsers(): Promise<UserDto[]> {
    const rows = await this.usersRepository.findAll();
    return rows.map((row) => this.mapper.toDto(row));
  }

  async inviteUser(dto: InviteUserDto): Promise<{ userId?: string }> {
    const userId = await this.usersRepository.inviteUser(dto.email, dto.fullName, dto.role);
    return { userId };
  }

  async updateUser(targetId: string, dto: UpdateUserDto): Promise<void> {
    const updates: ProfileUpdate = {};
    if (dto.fullName !== undefined) updates.full_name = dto.fullName;
    if (dto.role !== undefined) updates.role = dto.role as Role;
    if (dto.active !== undefined) updates.active = dto.active;

    if (Object.keys(updates).length === 0) {
      throw new BadRequestError("No fields to update");
    }

    await this.usersRepository.updateProfile(targetId, updates);
  }

  async deactivateUser(targetId: string, callerId: string): Promise<void> {
    if (targetId === callerId) {
      throw new BadRequestError("You cannot deactivate your own account");
    }

    await this.usersRepository.updateProfile(targetId, { active: false });
    await this.usersRepository.banAuthUser(targetId);
  }
}
