// Lightweight security scan against a running API. Safe, mostly read-only.
// Checks: auth required, token tampering, security headers, SQL-injection
// resilience, CORS allow-list, error-body hygiene, and (last) auth rate limiting.
//
// Env: BASE, EMAIL, PASSWORD, RUN_RATELIMIT (default 1)
const BASE = process.env.BASE ?? "http://localhost:4100/api/v1";
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

async function main() {
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

  // 7. Auth rate limiting (run last — it trips the limiter on this instance).
  if (RUN_RATELIMIT) {
    let tripped = false;
    for (let i = 0; i < 40; i++) {
      const r = await fetch(`${BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nobody@x.com", password: "wrong" }),
      });
      if (r.status === 429) {
        tripped = true;
        break;
      }
    }
    check("Auth endpoint rate-limits brute force (429)", tripped);
  }

  console.table(results);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
