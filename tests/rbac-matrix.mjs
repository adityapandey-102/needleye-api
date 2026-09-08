/**
 * A small, self-contained per-role API check (200/403/404/409) that exercises
 * the live capability matrix over HTTP -- so it runs identically against
 * localhost and a hosted API. This is the "zero code changes" proof for the
 * backend's behaviour at cutover (see docs/cutover-checklist.md, step 6), not
 * a replacement for the unit/integration suites.
 *
 * Covers all SIX roles and the post-ADR-0005 rules:
 *   - three status tiers (design / pm_received / production), gated by ROLE
 *     ONLY -- the old "must be assigned to the order" rule is gone;
 *   - forward-only status flow (backward or repeated stage -> 409);
 *   - Production Manager = designer-like but sees/edits EVERY order;
 *   - Worker = production-tier status changes, nothing else;
 *   - an authenticated outsider may VIEW one order read-only (payments stripped).
 *
 * Creates its own fixtures (fresh staff accounts + orders) every run, so it
 * never depends on prior seed data.
 *
 * Usage: npm run test:rbac  (API must be running; needs an existing
 * owner_manager's credentials)
 *   API_BASE_URL=https://<host>/api/v1 \
 *   SEED_OWNER_EMAIL=owner@example.com SEED_OWNER_PASSWORD=... npm run test:rbac
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

/** PATCH a status and return the HTTP code -- the status section is order-sensitive (forward-only). */
async function setStatus(orderId, status, token) {
  return (await req(`/orders/${orderId}/status`, { method: "PATCH", body: JSON.stringify({ status }) }, token)).status;
}

async function main() {
  const stamp = Date.now();
  const ownerToken = await login(OWNER_EMAIL, OWNER_PASSWORD);

  const designerA = await createStaff(ownerToken, "designer", "RBAC Designer A", stamp);
  const designerB = await createStaff(ownerToken, "designer", "RBAC Designer B", stamp);
  const masterA = await createStaff(ownerToken, "master_tailor", "RBAC Master A", stamp);
  const masterB = await createStaff(ownerToken, "master_tailor", "RBAC Master B", stamp);
  const accountant = await createStaff(ownerToken, "accountant", "RBAC Accountant", stamp);
  const productionManager = await createStaff(ownerToken, "production_manager", "RBAC Production Manager", stamp);
  const worker = await createStaff(ownerToken, "worker", "RBAC Worker", stamp);

  const designerAToken = await login(designerA.email, designerA.password);
  const designerBToken = await login(designerB.email, designerB.password);
  const masterAToken = await login(masterA.email, masterA.password);
  const masterBToken = await login(masterB.email, masterB.password);
  const accountantToken = await login(accountant.email, accountant.password);
  const pmToken = await login(productionManager.email, productionManager.password);
  const workerToken = await login(worker.email, worker.password);

  // One order assigned to designerA/masterA. designerB/masterB/worker are the
  // "not assigned to this order" counterfactuals.
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
        // Money crosses the wire as a 2dp string (ADR 0005). paymentStatus is
        // NOT accepted -- it is derived from the payment ledger.
        totalAmount: "5000.00",
        productionStatus: "design_pending",
      }),
    },
    ownerToken,
  );
  if (orderRes.status !== 201) throw new Error(`failed to create fixture order: ${JSON.stringify(orderRes.body)}`);
  const orderId = orderRes.body.order.id;

  console.log("\n--- authentication ---");
  check("GET /orders without a token -> 401", (await req("/orders")).status, 401);

  console.log("\n--- users:manage (owner_manager only) ---");
  check("GET /users as owner_manager -> 200", (await req("/users", {}, ownerToken)).status, 200);
  check("GET /users as designer -> 403", (await req("/users", {}, designerAToken)).status, 403);
  check("GET /users as master_tailor -> 403", (await req("/users", {}, masterAToken)).status, 403);
  check("GET /users as accountant -> 403", (await req("/users", {}, accountantToken)).status, 403);
  check("GET /users as production_manager -> 403", (await req("/users", {}, pmToken)).status, 403);
  check("GET /users as worker -> 403", (await req("/users", {}, workerToken)).status, 403);

  console.log("\n--- orders:create ---");
  const createBody = JSON.stringify({
    customerName: "Create Check",
    phone: "9123456781",
    billNumber: `BILL-CREATE-${stamp}`,
    dueDate: "2026-12-31",
    designerId: designerA.id,
    masterTailorId: masterA.id,
    productCategory: "saree",
    orderDetails: "orders:create capability check",
    totalAmount: "1000.00",
    productionStatus: "design_pending",
  });
  check("POST /orders as owner_manager -> 201", (await req("/orders", { method: "POST", body: createBody }, ownerToken)).status, 201);
  check("POST /orders as designer -> 201", (await req("/orders", { method: "POST", body: createBody }, designerAToken)).status, 201);
  check("POST /orders as production_manager -> 201", (await req("/orders", { method: "POST", body: createBody }, pmToken)).status, 201);
  check("POST /orders as master_tailor -> 403", (await req("/orders", { method: "POST", body: createBody }, masterAToken)).status, 403);
  check("POST /orders as accountant -> 403", (await req("/orders", { method: "POST", body: createBody }, accountantToken)).status, 403);
  check("POST /orders as worker -> 403", (await req("/orders", { method: "POST", body: createBody }, workerToken)).status, 403);

  console.log("\n--- orders:edit:pricing_assignment (owner_manager only) ---");
  const pricingPatch = JSON.stringify({ totalAmount: "9999.00" });
  check("PATCH /orders/:id {totalAmount} as owner_manager -> 200", (await req(`/orders/${orderId}`, { method: "PATCH", body: pricingPatch }, ownerToken)).status, 200);
  check("PATCH /orders/:id {totalAmount} as assigned designer -> 403", (await req(`/orders/${orderId}`, { method: "PATCH", body: pricingPatch }, designerAToken)).status, 403);
  check("PATCH /orders/:id {totalAmount} as master_tailor -> 403", (await req(`/orders/${orderId}`, { method: "PATCH", body: pricingPatch }, masterAToken)).status, 403);
  check(
    "PATCH /orders/:id {totalAmount} as production_manager -> 403 (PM edits info, never pricing)",
    (await req(`/orders/${orderId}`, { method: "PATCH", body: pricingPatch }, pmToken)).status,
    403,
  );

  console.log("\n--- orders:edit:customer_product_fields (PM edits ANY order) ---");
  const infoPatch = JSON.stringify({ orderDetails: "edited via rbac matrix" });
  check(
    "PATCH /orders/:id {orderDetails} as production_manager (not their order) -> 200",
    (await req(`/orders/${orderId}`, { method: "PATCH", body: infoPatch }, pmToken)).status,
    200,
  );
  check(
    "PATCH /orders/:id {orderDetails} as unassigned designer -> 403",
    (await req(`/orders/${orderId}`, { method: "PATCH", body: infoPatch }, designerBToken)).status,
    403,
  );
  check(
    "PATCH /orders/:id {orderDetails} as master_tailor -> 403",
    (await req(`/orders/${orderId}`, { method: "PATCH", body: infoPatch }, masterAToken)).status,
    403,
  );

  console.log("\n--- payments (owner / accountant / assigned designer only) ---");
  check("GET /orders/:orderId/payments as owner_manager -> 200", (await req(`/orders/${orderId}/payments`, {}, ownerToken)).status, 200);
  check("GET /orders/:orderId/payments as accountant -> 200", (await req(`/orders/${orderId}/payments`, {}, accountantToken)).status, 200);
  check("GET /orders/:orderId/payments as assigned designer -> 200", (await req(`/orders/${orderId}/payments`, {}, designerAToken)).status, 200);
  check("GET /orders/:orderId/payments as unassigned designer -> 403", (await req(`/orders/${orderId}/payments`, {}, designerBToken)).status, 403);
  check("GET /orders/:orderId/payments as master_tailor -> 403", (await req(`/orders/${orderId}/payments`, {}, masterAToken)).status, 403);
  check("GET /orders/:orderId/payments as production_manager -> 403", (await req(`/orders/${orderId}/payments`, {}, pmToken)).status, 403);
  check("GET /orders/:orderId/payments as worker -> 403", (await req(`/orders/${orderId}/payments`, {}, workerToken)).status, 403);
  check(
    "POST /orders/:orderId/payments as master_tailor -> 403",
    (await req(`/orders/${orderId}/payments`, { method: "POST", body: JSON.stringify({ amount: "100.00", method: "cash" }) }, masterAToken)).status,
    403,
  );

  console.log("\n--- single-order read: outsider VIEW is allowed, payments stripped ---");
  const outsiderView = await req(`/orders/${orderId}`, {}, designerBToken);
  check("GET /orders/:id as unassigned designer -> 200 (read-only view, e.g. via QR)", outsiderView.status, 200);
  check("  ...with totalAmount stripped from the response", outsiderView.body?.order?.totalAmount, undefined);
  check("  ...with paymentStatus stripped from the response", outsiderView.body?.order?.paymentStatus, undefined);
  check(
    "GET /orders/:id that does not exist -> 404",
    (await req("/orders/00000000-0000-0000-0000-000000000000", {}, designerBToken)).status,
    404,
  );

  // ---------------------------------------------------------------------------
  // Status tiers + forward-only. ORDER-SENSITIVE: each successful call advances
  // the fixture order, so these run as one scripted journey from design_pending.
  // ---------------------------------------------------------------------------
  console.log("\n--- status tier: design (owner / designer / PM) ---");
  check("PATCH status -> design_approved as master_tailor -> 403", await setStatus(orderId, "design_approved", masterAToken), 403);
  check("PATCH status -> design_approved as accountant -> 403", await setStatus(orderId, "design_approved", accountantToken), 403);
  check("PATCH status -> design_approved as worker -> 403", await setStatus(orderId, "design_approved", workerToken), 403);
  check("PATCH status -> design_approved as designer -> 200", await setStatus(orderId, "design_approved", designerAToken), 200);

  console.log("\n--- status tier: pm_received (owner / production_manager ONLY) ---");
  check("PATCH status -> production_manager_received as designer -> 403", await setStatus(orderId, "production_manager_received", designerAToken), 403);
  check("PATCH status -> production_manager_received as master_tailor -> 403", await setStatus(orderId, "production_manager_received", masterAToken), 403);
  check("PATCH status -> production_manager_received as production_manager -> 200", await setStatus(orderId, "production_manager_received", pmToken), 200);

  console.log("\n--- forward-only flow ---");
  check("PATCH status backwards -> design_approved as designer -> 409", await setStatus(orderId, "design_approved", designerAToken), 409);

  console.log("\n--- status tier: production (everyone on the floor, not the accountant) ---");
  check("PATCH status -> cutting as UNASSIGNED master_tailor -> 200 (no assignment rule)", await setStatus(orderId, "cutting", masterBToken), 200);
  check("PATCH status -> stitching as worker -> 200", await setStatus(orderId, "stitching", workerToken), 200);
  check("PATCH status -> stitching again (same stage) -> 409 (idempotent by rejection)", await setStatus(orderId, "stitching", designerAToken), 409);
  check("PATCH status -> finishing as accountant -> 403", await setStatus(orderId, "finishing", accountantToken), 403);

  console.log("\n--- dashboard + reports ---");
  check("GET /orders/stats as owner_manager -> 200", (await req("/orders/stats", {}, ownerToken)).status, 200);
  check("GET /orders/stats as master_tailor -> 200", (await req("/orders/stats", {}, masterAToken)).status, 200);
  check("GET /orders/stats as worker -> 200", (await req("/orders/stats", {}, workerToken)).status, 200);
  check("GET /orders/revenue as owner_manager -> 200", (await req("/orders/revenue", {}, ownerToken)).status, 200);
  check("GET /orders/revenue as accountant -> 200", (await req("/orders/revenue", {}, accountantToken)).status, 200);
  check("GET /orders/revenue as designer -> 403", (await req("/orders/revenue", {}, designerAToken)).status, 403);
  check("GET /orders/revenue as production_manager -> 403", (await req("/orders/revenue", {}, pmToken)).status, 403);
  check(
    "GET /orders/staff-report as owner_manager -> 200",
    (await req(`/orders/staff-report?staffId=${designerA.id}&month=2026-07`, {}, ownerToken)).status,
    200,
  );
  check(
    "GET /orders/staff-report as accountant -> 403 (financial != staff reporting)",
    (await req(`/orders/staff-report?staffId=${designerA.id}&month=2026-07`, {}, accountantToken)).status,
    403,
  );

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
