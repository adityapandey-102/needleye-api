import { afterAll, afterEach, describe, expect, it } from "vitest";
import { authProvider } from "../../src/common/auth/supabase-auth-provider";
import { fetchActiveProfile } from "../../src/common/database/profiles";
import { createFixtureUser, deleteFixtureUser, closeDb } from "./helpers";

/**
 * Authentication against the real local Supabase Auth (GoTrue) service --
 * no mocking of the identity provider. Covers sign-in, token verification,
 * and the profiles lookup requireAuth's middleware depends on (see
 * src/common/middleware/auth.middleware.ts).
 */
describe("SupabaseAuthProvider (integration)", () => {
  const createdUserIds: string[] = [];

  afterEach(async () => {
    while (createdUserIds.length) {
      const id = createdUserIds.pop();
      if (id) await deleteFixtureUser(id);
    }
  });

  afterAll(async () => {
    await closeDb();
  });

  it("signs in with a real password and returns a verifiable access token", async () => {
    const user = await createFixtureUser("accountant", "Integration Test Accountant");
    createdUserIds.push(user.id);

    const session = await authProvider.signInWithPassword(user.email, user.password);
    expect(session.userId).toBe(user.id);
    expect(session.accessToken).toBeTruthy();

    const verified = await authProvider.verifyAccessToken(session.accessToken);
    expect(verified?.userId).toBe(user.id);
  });

  it("rejects sign-in with the wrong password", async () => {
    const user = await createFixtureUser("designer", "Integration Test Designer");
    createdUserIds.push(user.id);

    await expect(authProvider.signInWithPassword(user.email, "definitely-wrong-password")).rejects.toThrow();
  });

  it("rejects verification of a garbage token", async () => {
    const verified = await authProvider.verifyAccessToken("not-a-real-token");
    expect(verified).toBeNull();
  });

  it("bans a user so their existing credentials can no longer sign in", async () => {
    const user = await createFixtureUser("master_tailor", "Integration Test Master");
    createdUserIds.push(user.id);

    await authProvider.banUser(user.id);
    await expect(authProvider.signInWithPassword(user.email, user.password)).rejects.toThrow();
  });

  it("loads the matching profiles row (role, active) that requireAuth depends on", async () => {
    const user = await createFixtureUser("designer", "Integration Test Profile Lookup");
    createdUserIds.push(user.id);

    const profile = await fetchActiveProfile(user.id);
    expect(profile.role).toBe("designer");
    expect(profile.active).toBe(true);
  });
});
