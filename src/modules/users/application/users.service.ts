import { env } from "../../../config/env";
import { BadRequestError, NotFoundError } from "../../../common/errors/app-error";
import { generatePassword, generateQrToken, hashToken } from "../../../common/crypto/credentials";
import { assertPasswordCanBeRegenerated, assertRoleSupportsQrLogin } from "../domain/account-credential.rules";
import { toUserResponseDto } from "../api/user.presenter";
import type { UsersRepositoryPort, ProfileUpdate } from "./ports/users-repository.port";
import type { UserResponseDto } from "../api/dto/user.response.dto";
import type { CreateUserDto } from "../api/dto/create-user.dto";
import type { UpdateUserDto } from "../api/dto/update-user.dto";

export class UsersService {
  constructor(private readonly usersRepository: UsersRepositoryPort) {}

  async listUsers(): Promise<UserResponseDto[]> {
    const entities = await this.usersRepository.findAll();
    return entities.map(toUserResponseDto);
  }

  /**
   * Creates the account directly with a real password -- no invite email.
   * The generated password is returned once in the response; the caller
   * (Owner/Manager) is responsible for communicating it to the new hire.
   */
  async createUser(dto: CreateUserDto): Promise<{ userId: string; password: string }> {
    const password = generatePassword(dto.fullName);
    const userId = await this.usersRepository.createUser(dto.email, dto.fullName, dto.role, password);
    return { userId, password };
  }

  async generatePassword(targetId: string): Promise<{ password: string }> {
    const target = await this.usersRepository.findById(targetId);
    if (!target) throw new NotFoundError("User not found");

    assertPasswordCanBeRegenerated(target.role, target.lastLoginAt);

    const password = generatePassword(target.fullName);
    await this.usersRepository.setPassword(targetId, password);
    return { password };
  }

  async generateQrToken(targetId: string): Promise<{ token: string; loginUrl: string }> {
    const target = await this.usersRepository.findById(targetId);
    if (!target) throw new NotFoundError("User not found");

    assertRoleSupportsQrLogin(target.role);

    const token = generateQrToken();
    await this.usersRepository.setQrToken(targetId, hashToken(token));
    return { token, loginUrl: `${env.WEB_APP_URL}/qr-login?token=${token}` };
  }

  async updateUser(targetId: string, dto: UpdateUserDto): Promise<void> {
    const updates: ProfileUpdate = {};
    if (dto.fullName !== undefined) updates.fullName = dto.fullName;
    if (dto.role !== undefined) updates.role = dto.role;
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
    // A deactivated account's QR (if any) must stop working immediately, not linger.
    await this.usersRepository.clearQrToken(targetId);
  }
}
