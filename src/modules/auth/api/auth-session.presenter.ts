import type { Profile } from "../../../domain";
import type { AuthTokens } from "../application/ports/auth-repository.port";
import type { AuthSessionResponseDto } from "./dto/auth-session.response.dto";

/** Tokens + profile -> API response DTO. Identical today; kept explicit so the two can diverge later without either leaking into the other. */
export function toAuthSessionResponseDto(tokens: AuthTokens, profile: Profile): AuthSessionResponseDto {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
    profile,
  };
}
