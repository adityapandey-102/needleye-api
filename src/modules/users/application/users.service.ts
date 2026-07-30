import { env } from "../../../config/env";
import { BadRequestError, NotFoundError } from "../../../common/errors/app-error";
import { ERROR_CODES } from "../../../common/errors/error-codes";
import { generatePassword, generateQrToken, hashToken } from "../../../common/crypto/credentials";
import { assertPasswordCanBeRegenerated, assertRoleSupportsQrLogin } from "../domain/account-credential.rules";
import { toUserResponseDto } from "../api/user.presenter";
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from "../../../common/audit/audit-actions";
import { auditLogger as defaultAuditLogger } from "../../../common/audit/drizzle-audit-logger";
import type { AuditLogger } from "../../../common/audit/audit-logger";
import type {
  UsersRepositoryPort,
  ProfileUpdate,
  UserListFilters,
  UserListPage,
} from "./ports/users-repository.port";
import type { UserResponseDto } from "../api/dto/user.response.dto";
import type { CreateUserDto } from "../api/dto/create-user.dto";
import type { UpdateUserDto } from "../api/dto/update-user.dto";

/** Paginated user list -- `total` is the full count matching the filters, for the pager. */
export interface UserListResult {
  users: UserResponseDto[];
  total: number;
  limit: number;
  offset: number;
}

export class UsersService {
  constructor(
    private readonly usersRepository: UsersRepositoryPort,
    private readonly audit: AuditLogger = defaultAuditLogger,
  ) {}

  async listUsers(filters: UserListFilters, page: UserListPage): Promise<UserListResult> {
    // Count + page in parallel -- same shape as OrdersService.listOrders.
    const [entities, total] = await Promise.all([
      this.usersRepository.findMany(filters, page),
      this.usersRepository.countMany(filters),
    ]);
    return { users: entities.map(toUserResponseDto), total, limit: page.limit, offset: page.offset };
  }

  async getUser(id: string): Promise<UserResponseDto> {
    const entity = await this.usersRepository.findById(id);
    if (!entity) throw new NotFoundError("User not found", ERROR_CODES.USER_NOT_FOUND);
    return toUserResponseDto(entity);
  }

  /**
   * Creates the account directly with a real password -- no invite email.
   * The generated password is returned once in the response; the caller
   * (Owner/Manager) is responsible for communicating it to the new hire.
   */
  async createUser(dto: CreateUserDto): Promise<{ userId: string; password: string }> {
    const password = generatePassword(dto.fullName);
    const userId = await this.usersRepository.createUser(dto.email, dto.fullName, dto.role, password);
    await this.audit.record({
      action: AUDIT_ACTIONS.USER_CREATED,
      entityType: AUDIT_ENTITIES.USER,
      entityId: userId,
      metadata: { role: dto.role },
    });
    return { userId, password };
  }

  async generatePassword(targetId: string): Promise<{ password: string }> {
    const target = await this.usersRepository.findById(targetId);
    if (!target) throw new NotFoundError("User not found", ERROR_CODES.USER_NOT_FOUND);

    assertPasswordCanBeRegenerated(target.role, target.lastLoginAt);

    const password = generatePassword(target.fullName);
    await this.usersRepository.setPassword(targetId, password);
    await this.audit.record({ action: AUDIT_ACTIONS.USER_PASSWORD_REGENERATED, entityType: AUDIT_ENTITIES.USER, entityId: targetId });
    return { password };
  }

  async generateQrToken(targetId: string): Promise<{ token: string; loginUrl: string }> {
    const target = await this.usersRepository.findById(targetId);
    if (!target) throw new NotFoundError("User not found", ERROR_CODES.USER_NOT_FOUND);

    assertRoleSupportsQrLogin(target.role);

    const token = generateQrToken();
    await this.usersRepository.setQrToken(targetId, hashToken(token));
    await this.audit.record({ action: AUDIT_ACTIONS.USER_QR_GENERATED, entityType: AUDIT_ENTITIES.USER, entityId: targetId });
    return { token, loginUrl: `${env.WEB_APP_URL}/qr-login?token=${token}` };
  }

  async updateUser(targetId: string, dto: UpdateUserDto): Promise<void> {
    const updates: ProfileUpdate = {};
    if (dto.fullName !== undefined) updates.fullName = dto.fullName;
    if (dto.role !== undefined) updates.role = dto.role;
    if (dto.active !== undefined) updates.active = dto.active;

    if (Object.keys(updates).length === 0) {
      throw new BadRequestError("No fields to update", ERROR_CODES.VALIDATION_NO_FIELDS);
    }

    await this.usersRepository.updateProfile(targetId, updates);
    await this.audit.record({
      action: AUDIT_ACTIONS.USER_UPDATED,
      entityType: AUDIT_ENTITIES.USER,
      entityId: targetId,
      metadata: { fields: Object.keys(updates) },
    });
  }

  async deactivateUser(targetId: string, callerId: string): Promise<void> {
    if (targetId === callerId) {
      throw new BadRequestError("You cannot deactivate your own account", ERROR_CODES.USER_CANNOT_DEACTIVATE_SELF);
    }

    await this.usersRepository.updateProfile(targetId, { active: false });
    await this.usersRepository.banAuthUser(targetId);
    // A deactivated account's QR (if any) must stop working immediately, not linger.
    await this.usersRepository.clearQrToken(targetId);
    await this.audit.record({ action: AUDIT_ACTIONS.USER_DEACTIVATED, entityType: AUDIT_ENTITIES.USER, entityId: targetId });
  }

  async reactivateUser(targetId: string): Promise<void> {
    const target = await this.usersRepository.findById(targetId);
    if (!target) throw new NotFoundError("User not found", ERROR_CODES.USER_NOT_FOUND);

    await this.usersRepository.updateProfile(targetId, { active: true });
    // Lift the Auth-layer ban so the account can sign in again. A fresh QR
    // must be issued separately -- deactivation cleared the old one.
    await this.usersRepository.unbanAuthUser(targetId);
    await this.audit.record({ action: AUDIT_ACTIONS.USER_REACTIVATED, entityType: AUDIT_ENTITIES.USER, entityId: targetId });
  }
}
