import { eq, sql } from "drizzle-orm";
import { db } from "../../src/common/database/drizzle-client";
import { orders } from "../../src/modules/orders/infrastructure/order.schema";
import { payments } from "../../src/modules/payments/infrastructure/payments.schema";
import { supabaseClient } from "../../src/common/database/supabase-client";
import { authProvider } from "../../src/common/auth/supabase-auth-provider";
import type { Role } from "../../src/domain";

/**
 * Shared fixtures for integration tests. Creates/tears down against the
 * real local Supabase stack (`npx supabase start`) -- these tests need
 * DATABASE_URL/SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY set (see .env), same
 * as running the app itself. No mocks: this is the point of an integration
 * test in this codebase's testing pyramid (see needleye-api/CLAUDE.md).
 *
 * Fixture creation goes through `authProvider.createUser` directly (not
 * the HTTP layer) so a test can mint an owner_manager/designer/master_tailor
 * account on demand without the once-only bootstrap rule getting in the
 * way -- the same bypass-the-Application-layer pattern `src/db/seed.ts`
 * already uses for the same reason.
 */

export interface FixtureUser {
  id: string;
  email: string;
  password: string;
  role: Role;
}

let counter = 0;
function uniqueEmail(role: Role): string {
  counter += 1;
  return `it-${role}-${Date.now()}-${counter}-${Math.random().toString(36).slice(2, 6)}@needleeye.test`;
}

export async function createFixtureUser(role: Role, fullName: string): Promise<FixtureUser> {
  const email = uniqueEmail(role);
  const password = `Test-${Math.random().toString(36).slice(2, 10)}!1`;
  const id = await authProvider.createUser({ email, password, fullName, role });
  return { id, email, password, role };
}

/** Deletes the auth user -- cascades to `profiles` via `on delete cascade` (see supabase/migrations/20260717000001_profiles.sql). */
export async function deleteFixtureUser(userId: string): Promise<void> {
  await supabaseClient.auth.admin.deleteUser(userId).catch(() => {
    // Best-effort teardown -- a test that already failed shouldn't also fail on cleanup.
  });
}

/**
 * Deletes a fixture order. Payments first: they no longer cascade (ON DELETE
 * RESTRICT, ADR 0008), and a delivered order's payments are locked by the
 * payments_guard trigger -- so that one delete runs with replica-mode triggers
 * off. Only the local test role can do that; the production runtime role
 * can't (it isn't allowed to set session_replication_role). The order itself
 * then cascades to its images and status / price history as usual.
 */
export async function deleteFixtureOrder(orderId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`);
    await tx.delete(payments).where(eq(payments.orderId, orderId));
    await tx.execute(sql`set local session_replication_role = origin`);
    await tx.delete(orders).where(eq(orders.id, orderId));
  });
}

/** Call once in an `afterAll` per test file so the Postgres pool doesn't keep the process alive. */
export async function closeDb(): Promise<void> {
  await db.$client.end();
}
