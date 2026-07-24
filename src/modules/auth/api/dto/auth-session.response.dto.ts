import type { Profile } from "../../../../domain";

/** Wire shape for every endpoint that hands back a live session (login, refresh, exchange-code, qr-login). */
export interface AuthSessionResponseDto {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  profile: Profile;
}
