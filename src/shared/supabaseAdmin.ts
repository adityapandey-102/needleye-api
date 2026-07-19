import { createClient } from "@supabase/supabase-js";
import { env } from "../config/env";

/**
 * Service-role client. Server-only -- never exposed to the browser.
 * Used for: verifying user JWTs (auth.getUser), admin user management,
 * and Storage access via the storageProvider abstraction.
 */
export const supabaseAdmin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
