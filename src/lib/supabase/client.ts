"use client";

import { createBrowserClient } from "@supabase/ssr";

/**
 * NEXT_PUBLIC_* values are inlined at build time, so each name has to appear as
 * a literal — a dynamic lookup would not be substituted. The second option in
 * each pair is what the Supabase↔Vercel integration provides.
 */
export function createSupabaseBrowserClient() {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_URL!;
  const key =
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;

  return createBrowserClient(url, key);
}
