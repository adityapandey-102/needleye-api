import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { db } from "../../src/common/database/drizzle-client";
import { authProvider } from "../../src/common/auth/supabase-auth-provider";
import { createFixtureUser, deleteFixtureUser, closeDb, type FixtureUser } from "./helpers";
import { businessToday } from "../../src/common/time/business-date";
import { env } from "../../src/config/env";

/**
 * Query budget: every list endpoint makes the SAME number of database queries
 * for a page of 5 as for a page of 50 (no N+1 -- one query per row would make
 * the second number ~10x the first), and every list caps its page size so no
 * request can pull an unbounded result.
 *
 * Counts queries at the connection pool, so it catches an N+1 in any layer
 * (service loops as well as repository ones). The heavier, volume-based check
 * is `npm run test:perf` (scripts/perf/query-audit.ts).
 */
describe("query budget: no N+1, bounded pages (integration)", () => {
  const app = createApp();
  let owner: FixtureUser;
  let auth: string;
  let count = 0;
  const pool = db.$client;
  const original = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;

  beforeAll(async () => {
    owner = await createFixtureUser("owner_manager", "Query Budget Owner");
    auth = `Bearer ${(await authProvider.signInWithPassword(owner.email, owner.password)).accessToken}`;
    (pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = (...args: unknown[]) => {
      count += 1;
      return original(...args);
    };
  });

  afterAll(async () => {
    (pool as unknown as { query: typeof original }).query = original;
    if (owner) await deleteFixtureUser(owner.id);
    await closeDb();
  });

  async function queriesFor(path: string): Promise<{ n: number; body: unknown }> {
    count = 0;
    const res = await request(app).get(path).set("Authorization", auth);
    expect(res.status, `${path} -> ${res.status}`).toBe(200);
    return { n: count, body: res.body };
  }

  const today = businessToday(new Date(), env.BUSINESS_TIMEZONE); // the shop day, as the API cuts days
  const lists: [string, (limit: number) => string][] = [
    ["orders", (l) => `/api/v1/orders?limit=${l}`],
    ["orders search", (l) => `/api/v1/orders?search=a&limit=${l}`],
    ["users", (l) => `/api/v1/users?limit=${l}`],
    ["ledger events", (l) => `/api/v1/orders/ledger-events?from=2020-01-01&to=${today}&limit=${l}`],
    ["team status", (l) => `/api/v1/reports/staff-activity?limit=${l}`],
    ["activity day", (l) => `/api/v1/reports/activity?day=${today}&limit=${l}`],
  ];

  for (const [name, path] of lists) {
    it(`${name}: a page of 50 costs no more queries than a page of 5`, async () => {
      const small = await queriesFor(path(5));
      const big = await queriesFor(path(50));
      expect(big.n, `${name}: ${small.n} queries for 5 rows, ${big.n} for 50`).toBe(small.n);
      expect(small.n).toBeLessThanOrEqual(6); // auth profile + page + total + batched extras
    });
  }

  it("order list rows carry no images (no image query, no storage signing)", async () => {
    const res = await request(app).get("/api/v1/orders?limit=5").set("Authorization", auth);
    const rows = (res.body as { orders: Record<string, unknown>[] }).orders;
    for (const row of rows) expect(row).not.toHaveProperty("images");
  });

  it("list page sizes are capped (an over-large limit is clamped or refused, never honoured)", async () => {
    const orders = await request(app).get("/api/v1/orders?limit=100000").set("Authorization", auth);
    expect((orders.body as { limit: number }).limit).toBeLessThanOrEqual(100);
    const users = await request(app).get("/api/v1/users?limit=100000").set("Authorization", auth);
    expect((users.body as { limit: number }).limit).toBeLessThanOrEqual(100);
    const team = await request(app).get("/api/v1/reports/staff-activity?limit=100000").set("Authorization", auth);
    expect(team.status).toBe(400);
    const activity = await request(app).get(`/api/v1/reports/activity?day=${today}&limit=100000`).set("Authorization", auth);
    expect(activity.status).toBe(400);
  });
});
