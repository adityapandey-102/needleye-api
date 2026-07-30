import { afterAll, afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authProvider } from "../../src/common/auth/supabase-auth-provider";
import { createFixtureUser, deleteFixtureUser, closeDb } from "./helpers";

/**
 * Integration coverage for the user-management and financial-reporting
 * endpoints added in the manual-testing-fixes pass: server-side user
 * pagination/search, single-user fetch, reactivate, the revenue report, and
 * the new dashboard stat/bucket surface -- real app, real auth, real Postgres.
 */
describe("Users & reports (integration)", () => {
  const app = createApp();
  const createdUserIds: string[] = [];

  async function ownerToken(): Promise<string> {
    const owner = await createFixtureUser("owner_manager", "Reports Owner");
    createdUserIds.push(owner.id);
    const session = await authProvider.signInWithPassword(owner.email, owner.password);
    return session.accessToken;
  }

  afterEach(async () => {
    for (const id of createdUserIds.splice(0)) await deleteFixtureUser(id);
  });

  afterAll(async () => {
    await closeDb();
  });

  it("paginates GET /users with a total and a bounded page", async () => {
    const token = await ownerToken();
    const res = await request(app).get("/api/v1/users?limit=2&offset=0").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body as { users: unknown[]; total: number; limit: number; offset: number };
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);
    expect(body.users.length).toBeLessThanOrEqual(2);
    expect(body.total).toBeGreaterThanOrEqual(1);
  });

  it("filters GET /users by a name search", async () => {
    const token = await ownerToken();
    const marker = `Zzsearch${Date.now()}`;
    const target = await createFixtureUser("designer", `${marker} Designer`);
    createdUserIds.push(target.id);

    const res = await request(app)
      .get(`/api/v1/users?search=${encodeURIComponent(marker)}`)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    const body = res.body as { users: { id: string }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.users[0]!.id).toBe(target.id);
  });

  it("fetches a single user via GET /users/:id", async () => {
    const token = await ownerToken();
    const target = await createFixtureUser("designer", "Single Fetch Designer");
    createdUserIds.push(target.id);

    const res = await request(app).get(`/api/v1/users/${target.id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect((res.body as { user: { id: string } }).user.id).toBe(target.id);
  });

  it("deactivates then reactivates a user", async () => {
    const token = await ownerToken();
    const target = await createFixtureUser("designer", "Toggle Designer");
    createdUserIds.push(target.id);

    const deactivate = await request(app)
      .post(`/api/v1/users/${target.id}/deactivate`)
      .set("Authorization", `Bearer ${token}`);
    expect(deactivate.status).toBe(204);

    const afterDeactivate = await request(app).get(`/api/v1/users/${target.id}`).set("Authorization", `Bearer ${token}`);
    expect((afterDeactivate.body as { user: { active: boolean } }).user.active).toBe(false);

    const reactivate = await request(app)
      .post(`/api/v1/users/${target.id}/reactivate`)
      .set("Authorization", `Bearer ${token}`);
    expect(reactivate.status).toBe(204);

    const afterReactivate = await request(app).get(`/api/v1/users/${target.id}`).set("Authorization", `Bearer ${token}`);
    expect((afterReactivate.body as { user: { active: boolean } }).user.active).toBe(true);
  });

  it("forbids a designer from listing users", async () => {
    const designer = await createFixtureUser("designer", "Nosy Designer");
    createdUserIds.push(designer.id);
    const session = await authProvider.signInWithPassword(designer.email, designer.password);

    const res = await request(app).get("/api/v1/users").set("Authorization", `Bearer ${session.accessToken}`);
    expect(res.status).toBe(403);
  });

  it("exposes the new dashboard stat fields to all roles, stripping payments for master_tailor", async () => {
    const masterTailor = await createFixtureUser("master_tailor", "Stats Master");
    createdUserIds.push(masterTailor.id);
    const session = await authProvider.signInWithPassword(masterTailor.email, masterTailor.password);

    const res = await request(app).get("/api/v1/orders/stats").set("Authorization", `Bearer ${session.accessToken}`);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    for (const field of ["total", "active", "completed", "thisMonth", "inProduction", "overdue", "urgent"]) {
      expect(body[field]).toBeTypeOf("number");
    }
    // Payment aggregates are stripped for master_tailor (no payments:read).
    expect(body.pendingPayments).toBeUndefined();
    expect(body.collectedRevenue).toBeUndefined();
  });

  it("accepts a bucket filter on GET /orders", async () => {
    const token = await ownerToken();
    const res = await request(app).get("/api/v1/orders?bucket=overdue").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray((res.body as { orders: unknown[] }).orders)).toBe(true);
  });

  it("returns a revenue report over a year range to owner_manager but forbids a designer", async () => {
    const token = await ownerToken();
    const ownerRes = await request(app)
      .get("/api/v1/orders/revenue?from=2026-01-01&to=2026-12-31")
      .set("Authorization", `Bearer ${token}`);
    expect(ownerRes.status).toBe(200);
    const report = ownerRes.body as { cycleStartDay: number; from: string; to: string; periods: unknown[] };
    expect(typeof report.cycleStartDay).toBe("number");
    expect(report.from).toBe("2026-01-01");
    expect(report.to).toBe("2026-12-31");
    expect(Array.isArray(report.periods)).toBe(true);

    const designer = await createFixtureUser("designer", "Broke Designer");
    createdUserIds.push(designer.id);
    const session = await authProvider.signInWithPassword(designer.email, designer.password);
    const designerRes = await request(app)
      .get("/api/v1/orders/revenue")
      .set("Authorization", `Bearer ${session.accessToken}`);
    expect(designerRes.status).toBe(403);
  });
});
