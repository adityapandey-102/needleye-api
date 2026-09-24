/**
 * Query audit -- `npm run test:perf` (LOCAL database only).
 *
 * Proves the app's real queries stay fast at production scale. It:
 *   1. runs every important repository method once against the local
 *      database, recording the exact SQL + parameters each one sends (and how
 *      many queries it takes -- a method whose count grows with the page size
 *      is an N+1);
 *   2. opens ONE transaction on a separate connection and fills it with ~3
 *      years of synthetic data (12,000 orders, ~150k stage moves, 24k
 *      payments, 360k audit rows), then ANALYZEs so the planner sees that
 *      volume;
 *   3. re-runs every recorded query inside that transaction with
 *      EXPLAIN (ANALYZE, BUFFERS) and checks it against the budget: no
 *      sequential scan over a big table, and under TIME_BUDGET_MS;
 *   4. ROLLS BACK. Nothing it inserted is ever committed.
 *
 * Exit code 1 if any query breaks the budget -- run it before a release.
 * `--write` also saves the table to docs/performance/query-audit.md.
 *
 * The SQL is captured from the real code, not copied into this file, so the
 * audit can't drift from what the app actually sends.
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import pg from "pg";
// pg's own parameter serialisation (arrays, dates, JSON) -- the same text it would send as a bind value.
import { prepareValue } from "pg/lib/utils.js";
import { db } from "../../src/common/database/drizzle-client";
import { DrizzleOrdersRepository } from "../../src/modules/orders/infrastructure/drizzle-orders.repository";
import { DrizzlePaymentsRepository } from "../../src/modules/payments/infrastructure/drizzle-payments.repository";
import { DrizzleUsersRepository } from "../../src/modules/users/infrastructure/drizzle-users.repository";
import { DrizzleTeamMembersRepository } from "../../src/modules/team-members/infrastructure/drizzle-team-members.repository";
import { DrizzleReportsRepository } from "../../src/modules/reports/infrastructure/drizzle-reports.repository";

const TIME_BUDGET_MS = 150;
/** A sequential scan over a table this big (actual rows read) fails the audit. */
const SEQ_SCAN_ROW_LIMIT = 5_000;
const BIG_TABLES = new Set(["orders", "order_status_history", "payments", "audit_log"]);
const VOLUME = { orders: 12_000, movesPerOrder: 12, paymentsPerOrder: 2, auditRows: 360_000 };

const url = process.env.DATABASE_URL ?? "";
if (!/@(127\.0\.0\.1|localhost)[:/]/.test(url)) {
  console.error("query-audit runs against the LOCAL database only (DATABASE_URL must point at 127.0.0.1/localhost).");
  process.exit(2);
}

// ── 1. capture ───────────────────────────────────────────────────────────────

interface Captured {
  text: string;
  values: unknown[];
}
let sink: Captured[] | null = null;
const pool = db.$client as pg.Pool;
const originalQuery = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
(pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = (...args: unknown[]) => {
  if (sink) {
    const [first, second] = args;
    if (typeof first === "string") sink.push({ text: first, values: (second as unknown[]) ?? [] });
    else if (first && typeof first === "object" && "text" in first) {
      const q = first as { text: string; values?: unknown[] };
      // drizzle passes (config, params); plain pg passes { text, values }.
      sink.push({ text: q.text, values: q.values ?? (second as unknown[] | undefined) ?? [] });
    }
  }
  return originalQuery(...args);
};

async function capture(run: () => Promise<unknown>): Promise<Captured[]> {
  sink = [];
  try {
    await run();
    return sink;
  } finally {
    sink = null;
  }
}

async function pick(sqlText: string): Promise<string> {
  const r = await pool.query<{ id: string }>(sqlText);
  const id = r.rows[0]?.id;
  if (!id) throw new Error(`query-audit needs seed data: ${sqlText}`);
  return id;
}

interface Case {
  name: string;
  run: () => Promise<unknown>;
  /** Same call with a bigger page: its query count must not grow (N+1 check). */
  runBig?: () => Promise<unknown>;
  /**
   * A whole-table read that is the POINT of the query (a shop-wide total): an
   * index can't make "sum every order" read fewer rows. Listed with the
   * reason; the time budget still applies to it.
   */
  expectedScan?: { tables: string[]; why: string };
}

const SHOP_WIDE = (tables: string[], why: string) => ({ tables, why });

async function main() {
  const designerId = await pick("select id from profiles where role = 'designer' and active limit 1");
  const masterId = await pick("select id from profiles where role = 'master_tailor' and active limit 1");
  const orderId = await pick("select id from orders order by created_at desc limit 1");
  const owner = { role: "owner_manager" as const, userId: designerId };
  const designer = { role: "designer" as const, userId: designerId };
  const today = new Date().toISOString().slice(0, 10);
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const month = today.slice(0, 7);

  const orders = new DrizzleOrdersRepository();
  const payments = new DrizzlePaymentsRepository();
  const users = new DrizzleUsersRepository();
  const team = new DrizzleTeamMembersRepository();
  const reports = new DrizzleReportsRepository();
  const W = { designerWindowDays: 45, floorWindowDays: 30 };

  const cases: Case[] = [
    {
      name: "orders list (owner, page)",
      run: () => orders.findMany(owner, {}, { limit: 5, offset: 0 }),
      runBig: () => orders.findMany(owner, {}, { limit: 50, offset: 0 }),
    },
    {
      name: "orders count (owner)",
      run: () => orders.countMany(owner, {}),
      expectedScan: SHOP_WIDE(["orders"], "counts every order in the shop (unfiltered pager total)"),
    },
    {
      name: "orders search 'priya'",
      run: () => orders.findMany(owner, { search: "priya" }, { limit: 20, offset: 0 }),
      expectedScan: SHOP_WIDE(["orders"], "trigram indexes exist; at 12k rows the planner judges one scan cheaper"),
    },
    {
      name: "orders search count",
      run: () => orders.countMany(owner, { search: "priya" }),
      expectedScan: SHOP_WIDE(["orders"], "trigram indexes exist; at 12k rows the planner judges one scan cheaper"),
    },
    { name: "orders bucket: overdue", run: () => orders.findMany(owner, { bucket: "overdue" }, { limit: 20, offset: 0 }) },
    { name: "orders bucket: pending_payment", run: () => orders.findMany(owner, { bucket: "pending_payment" }, { limit: 20, offset: 0 }) },
    {
      name: "orders list (designer's own)",
      run: () => orders.findMany(designer, {}, { limit: 20, offset: 0 }),
    },
    { name: "order by id", run: () => orders.findById(owner, orderId) },
    { name: "order status history", run: () => orders.listStatusHistory(orderId) },
    { name: "payment sums for a page", run: () => orders.sumPaymentsForOrders([orderId]) },
    {
      name: "dashboard stats (owner)",
      run: () => orders.getStats(owner),
      expectedScan: SHOP_WIDE(["orders", "payments"], "shop-wide dashboard totals: every order and payment is part of the answer"),
    },
    {
      name: "dashboard stats (designer)",
      run: () => orders.getStats(designer),
      expectedScan: SHOP_WIDE(["payments"], "one hash join over payments beats one index probe per order at this size"),
    },
    {
      name: "revenue report (year)",
      run: () => orders.getMonthlyRevenue(owner, 1, { from: yearStart, to: today }),
      expectedScan: SHOP_WIDE(["orders"], "shop-wide revenue for the year"),
    },
    { name: "staff report (one designer, month)", run: () => orders.getStaffReport(designerId, { from: `${month}-01`, to: today }) },
    { name: "ledger events page", run: () => orders.getLedgerEvents({ from: yearStart, to: today }, { limit: 20, offset: 0 }) },
    { name: "delivery load (2 months)", run: () => orders.countOrdersDueByDay({ from: `${month}-01`, to: today }) },
    { name: "payments for an order", run: () => payments.findByOrderId(orderId) },
    {
      name: "users list + search",
      run: () => users.findMany({ search: "a" }, { limit: 5, offset: 0 }),
      runBig: () => users.findMany({ search: "a" }, { limit: 50, offset: 0 }),
    },
    { name: "users count", run: () => users.countMany({ search: "a" }) },
    { name: "team members (designers)", run: () => team.findActive("designer") },
    {
      name: "reports: team status page",
      run: () => reports.getStaffWorkload({ ...W, limit: 5, offset: 0 }),
      runBig: () => reports.getStaffWorkload({ ...W, limit: 50, offset: 0 }),
    },
    { name: "reports: team status search", run: () => reports.getStaffWorkload({ ...W, search: "an", limit: 20, offset: 0 }) },
    { name: "reports: team status picker (masters)", run: () => reports.getStaffWorkload({ ...W, role: "master_tailor", limit: 20, offset: 0 }) },
    {
      name: "reports: activity day",
      run: () =>
        reports.getActivityDay({ day: today, timeZone: "Asia/Kolkata", excludePrefixes: ["payment."], limit: 50, offset: 0 }),
    },
  ];

  const recorded: { name: string; queries: Captured[]; bigCount?: number; expectedScan?: Case["expectedScan"] }[] = [];
  for (const c of cases) {
    const queries = await capture(c.run);
    const bigCount = c.runBig ? (await capture(c.runBig)).length : undefined;
    recorded.push({ name: c.name, queries, bigCount, expectedScan: c.expectedScan });
  }
  void masterId;

  // ── 2. synthetic volume, 3. explain, 4. rollback ────────────────────────────
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const findings: Row[] = [];
  try {
    await client.query("begin");
    // Session-local: skip triggers (the order-number trigger would renumber the
    // synthetic rows into the real sequence). No table lock; ends with the rollback.
    await client.query("set local session_replication_role = replica");
    const started = Date.now();
    await fillVolume(client);
    console.log(`Synthetic volume inserted + analyzed in ${((Date.now() - started) / 1000).toFixed(1)}s (inside a transaction that will be rolled back).`);

    for (const r of recorded) {
      for (const [i, q] of r.queries.entries()) {
        findings.push(await explain(client, r.name + (r.queries.length > 1 ? ` #${i + 1}` : ""), q, r));
      }
    }
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
    await pool.end();
  }

  report(findings);
}

// ── synthetic data ─────────────────────────────────────────────────────────────

async function fillVolume(client: pg.Client) {
  const staff = await client.query<{ ids: string[] }>(
    "select array_agg(id) as ids from profiles where active and role in ('designer','master_tailor','production_manager','worker','owner_manager')",
  );
  const designers = await client.query<{ ids: string[] }>("select array_agg(id) as ids from profiles where active and role = 'designer'");
  const masters = await client.query<{ ids: string[] }>("select array_agg(id) as ids from profiles where active and role = 'master_tailor'");
  const s = staff.rows[0]!.ids;
  const d = designers.rows[0]!.ids;
  const m = masters.rows[0]!.ids;

  // 12k orders over 3 years; anything older than 40 days is delivered (like real life).
  await client.query(
    `insert into orders (order_number, customer_name, phone, bill_number, booking_date, due_date, designer_id, master_tailor_id,
       product_category, order_details, payment_status, total_amount, production_status, created_by, created_at)
     select 'PERF-' || g, 'Perf Customer ' || g, '9000000000', 'PB-' || g, t.at::date, (t.at + interval '20 days')::date,
       ($1::uuid[])[1 + floor(random() * cardinality($1::uuid[]))::int],
       ($2::uuid[])[1 + floor(random() * cardinality($2::uuid[]))::int],
       'saree', 'synthetic', (array['unpaid','advance_paid','fully_paid'])[1 + floor(random() * 3)::int], 10000,
       case when t.at < now() - interval '40 days' then 'delivered'
            else (array['design_pending','cutting','stitching','finishing','quality_check'])[1 + floor(random() * 5)::int] end,
       ($1::uuid[])[1 + floor(random() * cardinality($1::uuid[]))::int],
       t.at
     from generate_series(1, $3::int) g
     cross join lateral (select now() - random() * interval '1095 days' + (g * 0) * interval '1 second' as at) t`,
    [d, m, VOLUME.orders],
  );
  await client.query(
    `insert into order_status_history (order_id, status, label, changed_by, created_at)
     select o.id, 'cutting', 'Cutting', ($1::uuid[])[1 + floor(random() * cardinality($1::uuid[]))::int],
            o.created_at + k * interval '1 day'
     from orders o cross join generate_series(1, $2::int) k
     where o.order_number like 'PERF-%'`,
    [s, VOLUME.movesPerOrder],
  );
  await client.query(
    `insert into payments (order_id, amount, method, paid_at, recorded_by, created_at)
     select o.id, 2500, 'cash', o.created_at + k * interval '3 days', ($1::uuid[])[1], o.created_at + k * interval '3 days'
     from orders o cross join generate_series(1, $2::int) k
     where o.order_number like 'PERF-%'`,
    [s, VOLUME.paymentsPerOrder],
  );
  await client.query(
    `with ids as (select array_agg(id) as a from orders where order_number like 'PERF-%')
     insert into audit_log (actor_id, action, entity_type, entity_id, created_at)
     select ($1::uuid[])[1 + floor(random() * cardinality($1::uuid[]))::int],
            x.action, x.entity, case when x.entity = 'order' then (ids.a[1 + floor(random() * cardinality(ids.a))::int])::text end,
            now() - random() * interval '1095 days'
     from generate_series(1, $2::int) g
     cross join ids
     cross join lateral (
       select (array['auth.login','order.status_changed','order.updated','order.created','payment.created'])[1 + floor(random() * 5)::int] as action
       offset (g * 0)
     ) a
     cross join lateral (select a.action, case when a.action like 'auth.%' then 'session' when a.action like 'payment.%' then 'payment' else 'order' end as entity) x`,
    [s, VOLUME.auditRows],
  );
  await client.query("analyze orders; analyze order_status_history; analyze payments; analyze audit_log; analyze profiles;");
}

// ── explain + budget ──────────────────────────────────────────────────────────

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  "Rows Removed by Filter"?: number;
  Plans?: PlanNode[];
}

interface Row {
  name: string;
  ms: number;
  queries: number;
  bigQueries?: number;
  seqScans: string[];
  problems: string[];
  notes: string[];
}

async function explain(
  client: pg.Client,
  name: string,
  q: Captured,
  r: { queries: Captured[]; bigCount?: number; expectedScan?: Case["expectedScan"] },
): Promise<Row> {
  // EXPLAIN can't take bind parameters, so inline them as escaped literals
  // (pg's own value serialisation, then escapeLiteral -- never string-glued).
  const inlined = q.text.replace(/\$(\d+)/g, (_m, n: string) => {
    const v = q.values[Number(n) - 1];
    return v === null || v === undefined ? "NULL" : client.escapeLiteral(String(prepareValue(v)));
  });
  const res = await client.query<{ "QUERY PLAN": [{ Plan: PlanNode; "Execution Time": number }] }>(
    `explain (analyze, buffers, format json) ${inlined}`,
  );
  const top = res.rows[0]!["QUERY PLAN"][0];
  const seqScans: string[] = [];
  const walk = (n: PlanNode) => {
    if (n["Node Type"] === "Seq Scan" && n["Relation Name"] && BIG_TABLES.has(n["Relation Name"])) {
      const read = ((n["Actual Rows"] ?? 0) + (n["Rows Removed by Filter"] ?? 0)) * (n["Actual Loops"] ?? 1);
      seqScans.push(`${n["Relation Name"]} (${read.toLocaleString()} rows)`);
      const expected = r.expectedScan?.tables.includes(n["Relation Name"]);
      if (expected) notes.add(`expected: ${r.expectedScan!.why}`);
      else if (read > SEQ_SCAN_ROW_LIMIT) problems.push(`seq scan on ${n["Relation Name"]} reading ${read.toLocaleString()} rows`);
    }
    n.Plans?.forEach(walk);
  };
  const problems: string[] = [];
  const notes = new Set<string>();
  walk(top.Plan);
  const ms = top["Execution Time"];
  if (ms > TIME_BUDGET_MS) problems.push(`${ms.toFixed(1)} ms > ${TIME_BUDGET_MS} ms budget`);
  if (r.bigCount !== undefined && r.bigCount > r.queries.length) {
    problems.push(`N+1: ${r.queries.length} queries for a page of 5 but ${r.bigCount} for a page of 50`);
  }
  return { name, ms, queries: r.queries.length, bigQueries: r.bigCount, seqScans, problems, notes: [...notes] };
}

function report(rows: Row[]) {
  const lines = [
    `| Query | Time (ms) | Queries/call | Big-table seq scans | Verdict |`,
    `| --- | ---: | ---: | --- | --- |`,
    ...rows.map(
      (r) =>
        `| ${r.name} | ${r.ms.toFixed(2)} | ${r.queries}${r.bigQueries !== undefined ? ` (page 50: ${r.bigQueries})` : ""} | ${
          r.seqScans.join(", ") || "none"
        } | ${r.problems.length ? `❌ ${r.problems.join("; ")}` : `✅${r.notes.length ? ` (${r.notes.join("; ")})` : ""}`} |`,
    ),
  ];
  const failed = rows.filter((r) => r.problems.length);
  const header = [
    `# Query audit`,
    ``,
    `Generated by \`npm run test:perf\` on ${new Date().toISOString().slice(0, 10)} against the local database plus synthetic volume:`,
    `${VOLUME.orders.toLocaleString()} orders, ~${(VOLUME.orders * VOLUME.movesPerOrder).toLocaleString()} stage moves, ` +
      `${(VOLUME.orders * VOLUME.paymentsPerOrder).toLocaleString()} payments, ${VOLUME.auditRows.toLocaleString()} audit rows (≈ 3 years at 300 orders/month),`,
    `inserted in a transaction that is rolled back. Budget: ≤ ${TIME_BUDGET_MS} ms, no sequential scan reading > ${SEQ_SCAN_ROW_LIMIT.toLocaleString()} rows of a big table, no N+1.`,
    ``,
    `**Result: ${failed.length === 0 ? "all within budget" : `${failed.length} over budget`}** (${rows.length} queries).`,
    ``,
  ];
  const out = [...header, ...lines, ""].join("\n");
  console.log(out);
  if (process.argv.includes("--write")) {
    mkdirSync("docs/performance", { recursive: true });
    writeFileSync("docs/performance/query-audit.md", out);
    console.log("Saved docs/performance/query-audit.md");
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
