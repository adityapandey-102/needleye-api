import { env } from "../../../config/env";
import { assertNoOwnerManagerExists } from "../domain/bootstrap.rules";
import { toAuthSessionResponseDto } from "../api/auth-session.presenter";
import type { AuthRepositoryPort, AuthTokens } from "./ports/auth-repository.port";
import type { BootstrapDto } from "../api/dto/bootstrap.dto";
import type { LoginDto } from "../api/dto/login.dto";
import type { RefreshDto } from "../api/dto/refresh.dto";
import type { PasswordResetRequestDto } from "../api/dto/password-reset-request.dto";
import type { PasswordUpdateDto } from "../api/dto/password-update.dto";
import type { ExchangeCodeDto } from "../api/dto/exchange-code.dto";
import type { QrLoginDto } from "../api/dto/qr-login.dto";
import type { AuthSessionResponseDto } from "../api/dto/auth-session.response.dto";

/**
 * Owns every auth operation the frontend needs, so needleye-web never talks
 * to Supabase Auth directly -- it only ever talks to this API. Every method
 * here is self-contained: no session is kept between calls, tokens are
 * always taken as explicit input and handed back in the return value.
 */
export class AuthService {
  constructor(private readonly authRepository: AuthRepositoryPort) {}

  async getBootstrapStatus(): Promise<{ ownerExists: boolean }> {
    const count = await this.authRepository.countOwnerManagers();
    return { ownerExists: count > 0 };
  }

  async bootstrap(dto: BootstrapDto): Promise<void> {
    const existingOwners = await this.authRepository.countOwnerManagers();
    assertNoOwnerManagerExists(existingOwners);

    await this.authRepository.createOwnerManagerUser(dto);
  }

  async login(dto: LoginDto): Promise<AuthSessionResponseDto> {
    const tokens = await this.authRepository.signInWithPassword(dto.email, dto.password);
    const session = await this.withProfile(tokens);
    // Only a real credential-based login counts -- not a silent refresh,
    // not exchange-code -- since this is what gates whether Owner/Manager
    // can still regenerate an owner_manager/accountant account's password.
    await this.authRepository.recordLogin(tokens.userId);
    return session;
  }

  async qrLogin(dto: QrLoginDto): Promise<AuthSessionResponseDto> {
    const tokens = await this.authRepository.signInWithQrToken(dto.token);
    return this.withProfile(tokens);
  }

  async refresh(dto: RefreshDto): Promise<AuthSessionResponseDto> {
    const tokens = await this.authRepository.refreshSession(dto.refreshToken);
    return this.withProfile(tokens);
  }

  async logout(accessToken: string): Promise<void> {
    await this.authRepository.signOut(accessToken);
  }

  async requestPasswordReset(dto: PasswordResetRequestDto): Promise<void> {
    const redirectTo = `${env.WEB_APP_URL}/auth/callback?next=/update-password`;
    await this.authRepository.requestPasswordReset(dto.email, redirectTo);
  }

  async updatePassword(userId: string, dto: PasswordUpdateDto): Promise<void> {
    await this.authRepository.updatePassword(userId, dto.newPassword);
  }

  async exchangeCode(dto: ExchangeCodeDto): Promise<AuthSessionResponseDto> {
    const tokens = await this.authRepository.exchangeCodeForSession(dto.code);
    return this.withProfile(tokens);
  }

  /**
   * Attaches the profile to a freshly-issued session, revoking the session
   * again if the account turns out to be inactive -- a deactivated user
   * should never walk away from login holding a live token.
   */
  private async withProfile(tokens: AuthTokens): Promise<AuthSessionResponseDto> {
    try {
      const profile = await this.authRepository.getProfile(tokens.userId);
      return toAuthSessionResponseDto(tokens, profile);
    } catch (err) {
      await this.authRepository.signOut(tokens.accessToken);
      throw err;
    }
  }
}
