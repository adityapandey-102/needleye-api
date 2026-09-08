import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  API_PORT: z.coerce.number().default(4000),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_ANON_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  STORAGE_BUCKET_NAME: z.string().default("order-images"),
  CORS_ALLOWED_ORIGIN: z.string().default("http://localhost:3000"),
  /** Where the frontend lives -- used to build the redirect URL Supabase puts in password-reset emails. */
  WEB_APP_URL: z.string().default("http://localhost:3000"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  /** Queries slower than this (ms) are logged at WARN for observability. See common/database/query-timing. */
  SLOW_QUERY_MS: z.coerce.number().default(250),
  /**
   * Max Postgres connections in the pool (the whole app shares one pool). The
   * main concurrency lever: raise it for higher simultaneous load, but keep it
   * comfortably under the database's connection limit (and, on Supabase, prefer
   * the pooler for a higher effective ceiling). Default 10 suits ~20-30
   * concurrent users; ~20-30 suits 60+.
   */
  DB_POOL_MAX: z.coerce.number().int().min(1).default(10),
  /** Auth rate-limit window (ms) and max requests per window per IP. Defaults: 15 min / 30 attempts. */
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(15 * 60 * 1000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().default(30),
  /**
   * Express `trust proxy` setting -- how many/which proxy hops sit in front of
   * the API, so the rate limiter keys on the real client IP from
   * X-Forwarded-For instead of the proxy's. Accepts a hop count ("1"), a
   * preset ("loopback"), or "false" to disable. Default trusts loopback: in
   * dev the Next.js session proxy calls the API over 127.0.0.1/::1 and forwards
   * XFF, which would otherwise make express-rate-limit throw. In production set
   * this to the number of proxies in front of the app (e.g. "1" behind one
   * reverse proxy). Never a blanket "true" (that lets any client spoof its IP).
   */
  TRUST_PROXY: z.string().default("loopback"),
  /** Day-of-month the monthly accounting/revenue cycle starts (1 = calendar month; e.g. 7 = 7th → next 7th). */
  ACCOUNTING_CYCLE_START_DAY: z.coerce.number().int().min(1).max(28).default(1),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration. Check apps/api/.env against .env.example.");
}

export const env = parsed.data;
