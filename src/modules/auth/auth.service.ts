import { ForbiddenError } from "../../common/errors/app-error";
import type { AuthRepository } from "./auth.repository";
import type { BootstrapDto } from "./dto/bootstrap.dto";

/**
 * Registration is invite-only in normal operation (the Users module's
 * invite flow sets a new account's role at invite time). This service
 * exists solely to bootstrap the very first Owner/Manager account on a
 * fresh install -- it refuses to do anything once one already exists, so
 * it can't be used to self-escalate after go-live.
 */
export class AuthService {
  constructor(private readonly authRepository: AuthRepository) {}

  async getBootstrapStatus(): Promise<{ ownerExists: boolean }> {
    const count = await this.authRepository.countOwnerManagers();
    return { ownerExists: count > 0 };
  }

  async bootstrap(dto: BootstrapDto): Promise<void> {
    const existingOwners = await this.authRepository.countOwnerManagers();
    if (existingOwners > 0) {
      throw new ForbiddenError("An Owner/Manager account already exists. Ask them for an invite.");
    }

    await this.authRepository.createOwnerManagerUser(dto);
  }
}
