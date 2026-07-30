import { describe, expect, it, vi, beforeEach } from "vitest";
import { UsersService } from "./users.service";
import { AUDIT_ACTIONS } from "../../../common/audit/audit-actions";
import type { AuditEvent, AuditLogger } from "../../../common/audit/audit-logger";
import type { UserAccountEntity } from "../domain/user-account.entity";
import type {
  UsersRepositoryPort,
  ProfileUpdate,
  UserListFilters,
  UserListPage,
} from "./ports/users-repository.port";

/**
 * Unit coverage for the Users application service against an in-memory fake
 * repository + audit sink -- exercises the pagination envelope, not-found
 * handling, and the reactivate/deactivate access rules with no DB. Repository
 * SQL itself is covered by the integration suite.
 */

function entity(overrides: Partial<UserAccountEntity> = {}): UserAccountEntity {
  return {
    id: "user-1",
    fullName: "Test Staff",
    email: "staff@example.com",
    role: "designer",
    active: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    lastLoginAt: null,
    hasQrLogin: false,
    ...overrides,
  };
}

class FakeUsersRepository implements UsersRepositoryPort {
  users: UserAccountEntity[] = [];
  updates: { id: string; updates: ProfileUpdate }[] = [];
  banned: string[] = [];
  unbanned: string[] = [];
  clearedQr: string[] = [];

  findMany(_filters: UserListFilters, page: UserListPage): Promise<UserAccountEntity[]> {
    return Promise.resolve(this.users.slice(page.offset, page.offset + page.limit));
  }
  countMany(): Promise<number> {
    return Promise.resolve(this.users.length);
  }
  findById(id: string): Promise<UserAccountEntity | null> {
    return Promise.resolve(this.users.find((u) => u.id === id) ?? null);
  }
  createUser(): Promise<string> {
    return Promise.resolve("new-id");
  }
  updateProfile(id: string, updates: ProfileUpdate): Promise<void> {
    this.updates.push({ id, updates });
    return Promise.resolve();
  }
  setPassword(): Promise<void> {
    return Promise.resolve();
  }
  setQrToken(): Promise<void> {
    return Promise.resolve();
  }
  clearQrToken(id: string): Promise<void> {
    this.clearedQr.push(id);
    return Promise.resolve();
  }
  banAuthUser(id: string): Promise<void> {
    this.banned.push(id);
    return Promise.resolve();
  }
  unbanAuthUser(id: string): Promise<void> {
    this.unbanned.push(id);
    return Promise.resolve();
  }
}

describe("UsersService", () => {
  let repo: FakeUsersRepository;
  let audit: AuditLogger & { events: AuditEvent[] };
  let service: UsersService;

  beforeEach(() => {
    repo = new FakeUsersRepository();
    const events: AuditEvent[] = [];
    audit = {
      events,
      record: vi.fn((e: AuditEvent) => {
        events.push(e);
        return Promise.resolve();
      }),
    };
    service = new UsersService(repo, audit);
  });

  describe("listUsers", () => {
    it("returns a paginated envelope with the full total", async () => {
      repo.users = [entity({ id: "a" }), entity({ id: "b" }), entity({ id: "c" })];
      const result = await service.listUsers({}, { limit: 2, offset: 0 });
      expect(result.total).toBe(3);
      expect(result.limit).toBe(2);
      expect(result.offset).toBe(0);
      expect(result.users).toHaveLength(2);
    });

    it("honours the offset window", async () => {
      repo.users = [entity({ id: "a" }), entity({ id: "b" }), entity({ id: "c" })];
      const result = await service.listUsers({}, { limit: 2, offset: 2 });
      expect(result.users.map((u) => u.id)).toEqual(["c"]);
    });
  });

  describe("getUser", () => {
    it("returns the user when found", async () => {
      repo.users = [entity({ id: "a", fullName: "Ana" })];
      const user = await service.getUser("a");
      expect(user.fullName).toBe("Ana");
    });

    it("throws USER_NOT_FOUND when missing", async () => {
      await expect(service.getUser("missing")).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
    });
  });

  describe("deactivateUser", () => {
    it("rejects deactivating your own account", async () => {
      repo.users = [entity({ id: "self" })];
      await expect(service.deactivateUser("self", "self")).rejects.toMatchObject({
        code: "USER_CANNOT_DEACTIVATE_SELF",
      });
      expect(repo.updates).toHaveLength(0);
    });

    it("deactivates: sets inactive, bans auth, clears QR, audits", async () => {
      repo.users = [entity({ id: "target" })];
      await service.deactivateUser("target", "admin");
      expect(repo.updates).toEqual([{ id: "target", updates: { active: false } }]);
      expect(repo.banned).toEqual(["target"]);
      expect(repo.clearedQr).toEqual(["target"]);
      expect(audit.events.map((e) => e.action)).toContain(AUDIT_ACTIONS.USER_DEACTIVATED);
    });
  });

  describe("reactivateUser", () => {
    it("reactivates: sets active, unbans auth, audits", async () => {
      repo.users = [entity({ id: "target", active: false })];
      await service.reactivateUser("target");
      expect(repo.updates).toEqual([{ id: "target", updates: { active: true } }]);
      expect(repo.unbanned).toEqual(["target"]);
      expect(audit.events.map((e) => e.action)).toContain(AUDIT_ACTIONS.USER_REACTIVATED);
    });

    it("throws USER_NOT_FOUND when the target is missing", async () => {
      await expect(service.reactivateUser("missing")).rejects.toMatchObject({ code: "USER_NOT_FOUND" });
    });
  });
});
