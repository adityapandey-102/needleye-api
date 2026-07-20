import { createClient } from "@supabase/supabase-js";
import { env } from "../../config/env";

/**
 * Service-role client. Server-only -- never exposed to the browser.
 * This is the single connection point every repository is built on top of;
 * nothing outside common/database and the repository classes should import
 * this directly.
 */
export const supabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
