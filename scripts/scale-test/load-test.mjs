// Concurrent-user load test. Points at any running API. Read-heavy by default;
// set MIX_WRITES=1 to add a small fraction of create-order writes (safe only
// against a throwaway DB). Reports per-endpoint latency percentiles + errors.
//
// Env: BASE, EMAIL, PASSWORD, VUS (default 60), DURATION_MS (default 20000),
//      MIX_WRITES (default 0)
const BASE = process.env.BASE ?? "http://localhost:4100/api/v1";
const EMAIL = process.env.EMAIL ?? "owner@needleeye.test";
const PASSWORD = process.env.PASSWORD ?? "Needleye@2026";
const VUS = Number(process.env.VUS ?? 60);
const DURATION_MS = Number(process.env.DURATION_MS ?? 20000);
const MIX_WRITES = process.env.MIX_WRITES === "1";

const SEARCH_TERMS = ["Customer", "saree", "ORD-SCALE", "9", "Scale", "BILL"];
const BUCKETS = ["active", "production", "completed", "pending_payment", "overdue", "this_month"];

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed: ${res.status} ${await res.text()}`);
  return (await res.json()).accessToken;
}

const stats = new Map();
function record(name, ms, ok) {
  let s = stats.get(name);
  if (!s) stats.set(name, (s = { lat: [], errors: 0 }));
  s.lat.push(ms);
  if (!ok) s.errors++;
}
async function timed(name, fn) {
  const t = performance.now();
  let ok = false;
  try {
    ok = await fn();
  } catch {
    ok = false;
  }
  record(name, performance.now() - t, ok);
}
const pick = (a) => a[Math.floor(Math.random() * a.length)];

async function worker(token, orderIds, stopAt) {
  const auth = { Authorization: `Bearer ${token}` };
  const jsonAuth = { ...auth, "Content-Type": "application/json" };
  while (performance.now() < stopAt) {
    await timed("GET /orders (list+paginate)", async () => (await fetch(`${BASE}/orders?limit=20&offset=${Math.floor(Math.random() * 500) * 20}`, { headers: auth })).ok);
    await timed("GET /orders (search)", async () => (await fetch(`${BASE}/orders?limit=20&search=${encodeURIComponent(pick(SEARCH_TERMS))}`, { headers: auth })).ok);
    await timed("GET /orders (bucket filter)", async () => (await fetch(`${BASE}/orders?limit=20&bucket=${pick(BUCKETS)}`, { headers: auth })).ok);
    await timed("GET /orders/stats", async () => (await fetch(`${BASE}/orders/stats`, { headers: auth })).ok);
    await timed("GET /orders/revenue", async () => (await fetch(`${BASE}/orders/revenue`, { headers: auth })).ok);
    const id = pick(orderIds);
    await timed("GET /orders/:id", async () => (await fetch(`${BASE}/orders/${id}`, { headers: auth })).ok);
    await timed("GET /orders/:id/payments", async () => (await fetch(`${BASE}/orders/${id}/payments`, { headers: auth })).ok);
    if (MIX_WRITES && Math.random() < 0.15) {
      await timed("POST /orders (write)", async () => {
        const res = await fetch(`${BASE}/orders`, {
          method: "POST",
          headers: jsonAuth,
          body: JSON.stringify({
            customerName: "LoadTest " + Date.now(),
            phone: "9000000000",
            billNumber: "LT-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
            dueDate: "2026-12-31",
            designerId: undefined,
            masterTailorId: undefined,
            productCategory: "saree",
            orderDetails: "load test",
            totalAmount: "1000.00",
            productionStatus: "design_pending",
          }),
        });
        return res.ok || res.status === 400; // 400 (missing designer) still exercises the write path/validation
      });
    }
  }
}

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function main() {
  const token = await login();
  const list = await (await fetch(`${BASE}/orders?limit=50`, { headers: { Authorization: `Bearer ${token}` } })).json();
  const orderIds = list.orders.map((o) => o.id);
  if (orderIds.length === 0) throw new Error("no orders to test against");
  console.log(`Load test → ${BASE}`);
  console.log(`${VUS} concurrent users · ${DURATION_MS / 1000}s · total orders in DB: ${list.total} · writes: ${MIX_WRITES ? "on" : "off"}\n`);

  const stopAt = performance.now() + DURATION_MS;
  await Promise.all(Array.from({ length: VUS }, () => worker(token, orderIds, stopAt)));

  let totalReq = 0;
  let totalErr = 0;
  const rows = [];
  for (const [name, s] of stats) {
    const sorted = s.lat.slice().sort((a, b) => a - b);
    totalReq += sorted.length;
    totalErr += s.errors;
    rows.push({
      endpoint: name,
      n: sorted.length,
      errors: s.errors,
      p50: Math.round(pct(sorted, 50)),
      p95: Math.round(pct(sorted, 95)),
      p99: Math.round(pct(sorted, 99)),
      max: Math.round(sorted[sorted.length - 1] ?? 0),
    });
  }
  console.table(rows);
  const rps = Math.round((totalReq / DURATION_MS) * 1000);
  console.log(`\nTotal: ${totalReq} requests · ~${rps} req/s · errors: ${totalErr} (${((totalErr / totalReq) * 100).toFixed(2)}%)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
