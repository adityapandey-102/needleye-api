import type { UserRow } from "./users.repository";
import type { UserDto } from "./dto/user.dto";

export class UsersMapper {
  toDto(row: UserRow): UserDto {
    return {
      id: row.id,
      fullName: row.full_name,
      email: row.email,
      role: row.role,
      active: row.active,
      createdAt: row.created_at,
    };
  }
}
