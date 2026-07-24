import type { UserAccountEntity } from "../domain/user-account.entity";
import type { UserResponseDto } from "./dto/user.response.dto";

/** Domain entity -> API response DTO. Identical today; kept explicit so the two can diverge later without either leaking into the other. */
export function toUserResponseDto(entity: UserAccountEntity): UserResponseDto {
  return { ...entity };
}
