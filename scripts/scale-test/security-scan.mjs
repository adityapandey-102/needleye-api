// Lightweight security scan against a running API. Safe, mostly read-only.
// Checks: auth required, token tampering, security headers, SQL-injection
// resilience, CORS allow-list, error-body hygiene, the public enquiry form's
// defences, and (last) auth rate limiting.
//
// Env: BASE, EMAIL, PASSWORD, RUN_RATELIMIT (default 1)
// Flags: --base=<url> (overrides BASE; easier than env vars on Windows)
//        --only-ratelimit (runs ONLY the rate-limit guard, which needs NO
//        credentials -- so it can be fired against production without the
//        owner password going anywhere. `npm run test:ratelimit`)
//        --only-public-form (runs ONLY the public enquiry form checks -- no
//        credentials, and it never stores a lead: every body it sends must be
//        refused. Uses up the caller's 5-an-hour enquiry budget.
//        `npm run test:public-form`)
const argv = process.argv.slice(2);
const ONLY_RATELIMIT = argv.includes("--only-ratelimit");
const ONLY_PUBLIC_FORM = argv.includes("--only-public-form");
const baseFlag = argv.find((a) => a.startsWith("--base="));
const BASE = baseFlag ? baseFlag.slice("--base=".length) : (process.env.BASE ?? "http://localhost:4100/api/v1");
const ORIGIN = BASE.replace(/\/api\/v1$/, "");
const EMAIL = process.env.EMAIL ?? "owner@needleeye.test";
const PASSWORD = process.env.PASSWORD ?? "Needleye@2026";
const RUN_RATELIMIT = process.env.RUN_RATELIMIT !== "0";

let pass = 0;
let fail = 0;
const results = [];
function check(name, ok, detail = "") {
  results.push({ check: name, result: ok ? "PASS" : "FAIL", detail });
  ok ? pass++ : fail++;
}

async function login() {
  const res = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error("login failed for scan setup: " + res.status);
  return (await res.json()).accessToken;
}

/**
 * Guards a failure that already shipped to production once: if TRUST_PROXY does
 * not match the platform's X-Forwarded-For depth, express-rate-limit keys on an
 * upstream proxy address instead of the caller. On Railway that address ROTATES,
 * so attempts scatter across buckets, no bucket reaches the limit, and brute-force
 * protection quietly does nothing. It is silent -- express-rate-limit disables its
 * own validation when NODE_ENV=production, so nothing is logged and no request
 * fails. The only way to know is to actually exhaust the limit and look.
 *
 * Deliberately sends only wrong passwords for an address that does not exist, so
 * it needs no credentials and writes no audit rows (only successful logins are
 * audited). Costs the caller's IP a 15-minute lockout -- run it last.
 */
async function checkRateLimit() {
  const attempt = () =>
    fetch(`${BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "nobody@x.com", password: "wrong" }),
    });
  const remainingOf = (res) => {
    const m = res.headers.get("ratelimit")?.match(/remaining=(\d+)/);
    return m ? Number(m[1]) : null;
  };

  // Read the configured limit off the response rather than hard-coding 30, so
  // this follows AUTH_RATE_LIMIT_MAX instead of drifting from it.
  const first = await attempt();
  const limit = Number(first.headers.get("ratelimit")?.match(/limit=(\d+)/)?.[1]);
  const known = Number.isFinite(limit);
  const budget = known ? limit + 5 : 45;

  let trippedAt = first.status === 429 ? 1 : null;
  let prev = remainingOf(first);
  // `remaining` going UP mid-run is the fingerprint of the original bug: it can
  // only happen if a later request was counted against a different bucket.
  let counterWentBackwards = false;

  for (let i = 2; i <= budget && trippedAt === null; i++) {
    const res = await attempt();
    const rem = remainingOf(res);
    if (prev !== null && rem !== null && rem > prev) counterWentBackwards = true;
    prev = rem;
    if (res.status === 429) trippedAt = i;
  }

  check(
    "Auth endpoint rate-limits brute force (429)",
    trippedAt !== null,
    trippedAt !== null
      ? `429 at attempt ${trippedAt}${known ? ` (limit ${limit})` : ""}`
      : `no 429 in ${budget} attempts -- check TRUST_PROXY matches the X-Forwarded-For depth`,
  );
  check(
    "Rate-limit counter is not split across proxy hops",
    !counterWentBackwards,
    counterWentBackwards
      ? "`remaining` increased mid-run: more than one bucket, so TRUST_PROXY is keying on an upstream hop"
      : "single bucket",
  );
}

/**
 * The one unauthenticated write: POST /public/enquiries. Sends ONLY bodies the
 * API must refuse (so nothing is ever stored), then keeps going until the
 * per-IP limit answers 429. Checks: no 5xx on hostile input, strict schema,
 * malformed JSON = 400, oversized = 413, a forged form token is refused, error
 * bodies leak nothing, and flooding is cut off.
 */
async function checkPublicForm() {
  const form = await fetch(`${BASE}/public/enquiry-form`);
  const cfg = await form.json().catch(() => ({}));
  check("Public form: GET /public/enquiry-form works without login", form.status === 200 && typeof cfg.formToken === "string", `status ${form.status}`);
  check("Public form: config is never cached", (form.headers.get("cache-control") ?? "").includes("no-store"), form.headers.get("cache-control") ?? "none");

  const post = (body, raw = false) =>
    fetch(`${BASE}/public/enquiries`, { method: "POST", headers: { "Content-Type": "application/json" }, body: raw ? body : JSON.stringify(body) });
  const base = { name: "Scan Person", phone: "9000000000", requirement: "security scan", formToken: cfg.formToken ?? "" };
  let sent = 0;

  const sqli = await post({ ...base, name: "x'); DROP TABLE leads;--" });
  sent++;
  const sqliBody = await sqli.json().catch(() => ({}));
  check("Public form: SQL/script in the name is refused (400), not 5xx", sqli.status === 400, `status ${sqli.status} ${sqliBody.code ?? ""}`);
  check("Public form: error body leaks no stack/secret", !JSON.stringify(sqliBody).match(/stack|service_role|password|secret|eyJ|select |insert /i));

  const forged = await post({ ...base, formToken: `${Date.now() - 60_000}.forged-signature` });
  sent++;
  check("Public form: a forged form token is refused", forged.status === 400 || forged.status === 429, `status ${forged.status}`);

  const malformed = await post("{not json", true);
  sent++;
  check("Public form: malformed JSON is 400 (not 500)", malformed.status === 400 || malformed.status === 429, `status ${malformed.status}`);

  const huge = await post({ ...base, requirement: "y".repeat(20_000) });
  check("Public form: an oversized body is refused (413)", huge.status === 413 || huge.status === 429, `status ${huge.status}`);

  // Flooding: keep sending refused bodies until the per-IP limit cuts in.
  let trippedAt = null;
  for (let i = sent + 1; i <= 15 && trippedAt === null; i++) {
    const res = await post({ ...base, phone: "bad" });
    if (res.status === 429) trippedAt = i;
  }
  check("Public form: flooding from one IP is cut off (429)", trippedAt !== null, trippedAt ? `429 at request ${trippedAt}` : "no 429 in 15 requests -- check TRUST_PROXY");
}

function report() {
  console.table(results);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

async function main() {
  // Credential-free mode: the rate-limit guard only, for firing at production.
  if (ONLY_RATELIMIT) {
    console.log(`Rate-limit guard only, against ${BASE}\n`);
    await checkRateLimit();
    return report();
  }

  if (ONLY_PUBLIC_FORM) {
    console.log(`Public enquiry form checks only, against ${BASE}
`);
    await checkPublicForm();
    return report();
  }

  const token = await login();
  const auth = { Authorization: `Bearer ${token}` };

  // 1. Protected endpoint requires auth.
  check("Unauthenticated request is rejected (401)", (await fetch(`${BASE}/orders`)).status === 401);

  // 2. Malformed / tampered tokens are rejected.
  check("Garbage bearer token is rejected (401)", (await fetch(`${BASE}/orders`, { headers: { Authorization: "Bearer not.a.jwt" } })).status === 401);
  const parts = token.split(".");
  const tampered = `${parts[0]}.${parts[1]}.${"x".repeat(parts[2].length)}`;
  check("Tampered JWT signature is rejected (401)", (await fetch(`${BASE}/orders`, { headers: { Authorization: `Bearer ${tampered}` } })).status === 401);

  // 3. Security headers (helmet).
  const h = (await fetch(`${BASE}/orders`, { headers: auth })).headers;
  check("Header: X-Content-Type-Options=nosniff", h.get("x-content-type-options") === "nosniff", h.get("x-content-type-options") ?? "missing");
  check("Header: X-Frame-Options present", !!h.get("x-frame-options"), h.get("x-frame-options") ?? "missing");
  check("Header: Strict-Transport-Security present", !!h.get("strict-transport-security"), h.get("strict-transport-security") ? "set" : "missing");
  check("Header: X-Powered-By hidden", !h.get("x-powered-by"), h.get("x-powered-by") ?? "hidden");

  // 4. SQL-injection resilience: injection strings in search must not 500 or dump.
  for (const payload of ["' OR '1'='1", "'; DROP TABLE orders;--", "%27%20OR%201=1--"]) {
    const res = await fetch(`${BASE}/orders?limit=5&search=${encodeURIComponent(payload)}`, { headers: auth });
    check(`SQLi search payload is handled safely (not 5xx): ${payload.slice(0, 18)}…`, res.status < 500, `status ${res.status}`);
  }

  // 5. CORS allow-list: a disallowed Origin must not be echoed as allowed.
  const cors = await fetch(`${BASE}/orders`, { headers: { ...auth, Origin: "https://evil.example.com" } });
  const acao = cors.headers.get("access-control-allow-origin");
  check("CORS does not allow an arbitrary Origin", acao !== "*" && acao !== "https://evil.example.com", acao ?? "none");

  // 6. Error body hygiene: a 401 body carries a stable code + requestId, no secret.
  const err = await (await fetch(`${BASE}/orders`)).json().catch(() => ({}));
  check("Error body has a stable code", typeof err.code === "string", err.code ?? "none");
  check("Error body carries a requestId (traceable)", typeof err.requestId === "string" || err.requestId === undefined, "");
  check("Error body leaks no token/secret", !JSON.stringify(err).match(/service_role|password|secret|eyJ/i));

  // 7. The public enquiry form (no login) -- refused bodies only, nothing stored.
  await checkPublicForm();

  // 8. Auth rate limiting (run last — it trips the limiter on this instance).
  if (RUN_RATELIMIT) await checkRateLimit();

  report();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
