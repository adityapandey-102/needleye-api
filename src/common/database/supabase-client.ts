import { createClient } from "@supabase/supabase-js";
import { env } from "../../config/env";

/**
 * Service-role client. Server-only -- never exposed to the browser.
 * This is the single connection point every repository is built on top of;
 * nothing outside common/database and the repository classes should import
 * this directly. Used for privileged/admin operations (RLS bypass, user
 * management) -- never for password-grant sign-in on a user's behalf.
 */
export const supabaseClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/**
 * Anon-key client, used only by the Auth module for the operations a public
 * client would normally perform itself (sign in, refresh, password reset,
 * code exchange). The API is stateless -- persistSession/autoRefreshToken
 * are off here too, since nothing is ever kept between requests; every call
 * takes whatever token it needs as an explicit argument and every response
 * hands tokens back in the JSON body, never in a server-side session.
 */
export const supabaseAuthClient = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
