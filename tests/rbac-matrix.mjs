/**
 * A small, self-contained per-role 200/403 API check -- not a full test
 * suite (see README's "No automated test suite yet" note; this is the
 * first automated check in the repo, matched to what a real boutique ERP
 * needs to trust before go-live, not a rewrite of that decision).
 *
 * Creates its own fixtures (fresh staff accounts + one order) every run, so
 * it never depends on prior seed data or manual setup -- just an
 * `owner_manager` bootstrapped and the API running locally.
 *
 * Usage: npm run test:rbac (needs `npm run dev` running in another terminal,
 * against a local Supabase stack with at least one owner_manager account).
 */
const BASE = process.env.API_BASE_URL ?? "http://localhost:4000/api/v1";
const OWNER_EMAIL = process.env.SEED_OWNER_EMAIL ?? "owner@needleeye.test";
const OWNER_PASSWORD = process.env.SEED_OWNER_PASSWORD;

if (!OWNER_PASSWORD) {
  console.error("Set SEED_OWNER_PASSWORD to an existing owner_manager account's password before running this.");
  process.exit(1);
}

async function req(path, opts = {}, token) {
  const headers = { "Content-Type": "application/json", ...(opts.headers ?? {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  let body = null;
  try {
    body = await res.json();
  } catch {
    // no JSON body (e.g. 204) -- fine, body stays null
  }
  return { status: res.status, body };
}

async function login(email, password) {
  const r = await req("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  if (r.status !== 200) throw new Error(`login failed for ${email}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.accessToken;
}

const results = [];
function check(label, actual, expected) {
  const pass = actual === expected;
  results.push({ label, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${label}  (expected ${expected}, got ${actual})`);
}

async function createStaff(ownerToken, role, name, stamp) {
  const email = `rbac-${role}-${stamp}-${Math.random().toString(36).slice(2, 6)}@needleeye.test`;
  const r = await req("/users", { method: "POST", body: JSON.stringify({ email, fullName: name, role }) }, ownerToken);
  if (r.status !== 201) throw new Error(`failed to create ${role} fixture: ${JSON.stringify(r.body)}`);
  return { email, password: r.body.password, id: r.body.userId };
}

async function main() {
  const stamp = Date.now();
  const ownerToken = await login(OWNER_EMAIL, OWNER_PASSWORD);

  const designerA = await createStaff(ownerToken, "designer", "RBAC Designer A", stamp);
  const designerB = await createStaff(ownerToken, "designer", "RBAC Designer B", stamp);
  const masterA = await createStaff(ownerToken, "master_tailor", "RBAC Master A", stamp);
  const masterB = await createStaff(ownerToken, "master_tailor", "RBAC Master B", stamp);
  const accountant = await createStaff(ownerToken, "accountant", "RBAC Accountant", stamp);

  const designerAToken = await login(designerA.email, designerA.password);
  const designerBToken = await login(designerB.email, designerB.password);
  const masterAToken = await login(masterA.email, masterA.password);
  const masterBToken = await login(masterB.email, masterB.password);
  const accountantToken = await login(accountant.email, accountant.password);

  // One order assigned to designerA/masterA -- designerB/masterB are the
  // "unassigned" counterfactual every ownership check below relies on.
  const orderRes = await req(
    "/orders",
    {
      method: "POST",
      body: JSON.stringify({
        customerName: "RBAC Matrix Test",
        phone: "9123456780",
        billNumber: `BILL-RBAC-${stamp}`,
        dueDate: "2026-12-31",
        designerId: designerA.id,
        masterTailorId: masterA.id,
        productCategory: "saree",
        orderDetails: "rbac matrix fixture",
        paymentStatus: "advance_paid",
        totalAmount: 5000,
        productionStatus: "design_pending",
      }),
    },
    ownerToken,
  );
  if (orderRes.status !== 201) throw new Error(`failed to create fixture order: ${JSON.stringify(orderRes.body)}`);
  const orderId = orderRes.body.order.id;

  check("GET /orders without a token -> 401", (await req("/orders")).status, 401);

  check("GET /users as owner_manager -> 200", (await req("/users", {}, ownerToken)).status, 200);
  check("GET /users as designer -> 403", (await req("/users", {}, designerAToken)).status, 403);
  check("GET /users as master_tailor -> 403", (await req("/users", {}, masterAToken)).status, 403);
  check("GET /users as accountant -> 403", (await req("/users", {}, accountantToken)).status, 403);

  const createBody = JSON.stringify({
    customerName: "Create Check",
    phone: "9123456781",
    billNumber: `BILL-CREATE-${stamp}`,
    dueDate: "2026-12-31",
    designerId: designerA.id,
    masterTailorId: masterA.id,
    productCategory: "saree",
    orderDetails: "orders:create capability check",
    paymentStatus: "advance_paid",
    totalAmount: 1000,
    productionStatus: "design_pending",
  });
  check("POST /orders as owner_manager -> 201", (await req("/orders", { method: "POST", body: createBody }, ownerToken)).status, 201);
  check("POST /orders as designer -> 201", (await req("/orders", { method: "POST", body: createBody }, designerAToken)).status, 201);
  check("POST /orders as master_tailor -> 403", (await req("/orders", { method: "POST", body: createBody }, masterAToken)).status, 403);
  check("POST /orders as accountant -> 403", (await req("/orders", { method: "POST", body: createBody }, accountantToken)).status, 403);

  const pricingPatch = JSON.stringify({ totalAmount: 9999 });
  check(
    "PATCH /orders/:id {totalAmount} as owner_manager -> 200",
    (await req(`/orders/${orderId}`, { method: "PATCH", body: pricingPatch }, ownerToken)).status,
    200,
  );
  check(
    "PATCH /orders/:id {totalAmount} as assigned designer -> 403",
    (await req(`/orders/${orderId}`, { method: "PATCH", body: pricingPatch }, designerAToken)).status,
    403,
  );
  check(
    "PATCH /orders/:id {totalAmount} as master_tailor -> 403",
    (await req(`/orders/${orderId}`, { method: "PATCH", body: pricingPatch }, masterAToken)).status,
    403,
  );

  check("GET /orders/:orderId/payments as owner_manager -> 200", (await req(`/orders/${orderId}/payments`, {}, ownerToken)).status, 200);
  check("GET /orders/:orderId/payments as accountant -> 200", (await req(`/orders/${orderId}/payments`, {}, accountantToken)).status, 200);
  check("GET /orders/:orderId/payments as assigned designer -> 200", (await req(`/orders/${orderId}/payments`, {}, designerAToken)).status, 200);
  check("GET /orders/:orderId/payments as unassigned designer -> 403", (await req(`/orders/${orderId}/payments`, {}, designerBToken)).status, 403);
  check("GET /orders/:orderId/payments as master_tailor -> 403", (await req(`/orders/${orderId}/payments`, {}, masterAToken)).status, 403);
  check(
    "POST /orders/:orderId/payments as master_tailor -> 403",
    (await req(`/orders/${orderId}/payments`, { method: "POST", body: JSON.stringify({ amount: 100, method: "cash" }) }, masterAToken)).status,
    403,
  );

  check(
    "PATCH /orders/:id/status -> cutting (production stage) as assigned designer -> 403",
    (await req(`/orders/${orderId}/status`, { method: "PATCH", body: JSON.stringify({ status: "cutting" }) }, designerAToken)).status,
    403,
  );
  check(
    "PATCH /orders/:id/status -> cutting (production stage) as unassigned master_tailor -> 403",
    (await req(`/orders/${orderId}/status`, { method: "PATCH", body: JSON.stringify({ status: "cutting" }) }, masterBToken)).status,
    403,
  );
  check(
    "PATCH /orders/:id/status -> cutting (production stage) as assigned master_tailor -> 200",
    (await req(`/orders/${orderId}/status`, { method: "PATCH", body: JSON.stringify({ status: "cutting" }) }, masterAToken)).status,
    200,
  );
  check(
    "PATCH /orders/:id/status -> design_approved (design stage) as assigned master_tailor -> 403",
    (await req(`/orders/${orderId}/status`, { method: "PATCH", body: JSON.stringify({ status: "design_approved" }) }, masterAToken)).status,
    403,
  );

  check(
    "GET /orders/:id as unassigned designer -> 404 (row-scoped, not 403 -- existence isn't confirmed)",
    (await req(`/orders/${orderId}`, {}, designerBToken)).status,
    404,
  );

  check("GET /orders/stats as owner_manager -> 200", (await req("/orders/stats", {}, ownerToken)).status, 200);
  check("GET /orders/stats as master_tailor -> 200", (await req("/orders/stats", {}, masterAToken)).status, 200);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
  if (failed.length > 0) {
    console.log("\nFailed checks:");
    for (const f of failed) console.log(`  - ${f.label}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
