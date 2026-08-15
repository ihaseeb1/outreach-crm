import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { env } from "@/lib/env";

let cached: SupabaseClient | null = null;

/**
 * Service-role client. Bypasses RLS — only ever used by background jobs
 * (/api/cron/*) and by server code that has already authorised the caller.
 * Never import this into a client component.
 */
export function createSupabaseAdminClient(): SupabaseClient {
  if (cached) return cached;
  cached = createClient(env.supabaseUrl(), env.supabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
