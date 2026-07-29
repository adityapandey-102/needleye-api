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
  /** Auth rate-limit window (ms) and max requests per window per IP. Defaults: 15 min / 30 attempts. */
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(15 * 60 * 1000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().default(30),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  throw new Error("Invalid environment configuration. Check apps/api/.env against .env.example.");
}

export const env = parsed.data;
