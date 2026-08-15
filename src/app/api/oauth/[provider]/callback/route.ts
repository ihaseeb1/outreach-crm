import { NextResponse } from "next/server";

import { logActivity } from "@/lib/activity";
import { decryptSecret, encryptJson } from "@/lib/crypto";
import { normalizeEmail } from "@/lib/email";
import { env } from "@/lib/env";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { presetFor } from "@/mail/providers/presets";
import { exchangeCode, fetchAuthorizedEmail } from "@/mail/providers/oauth";
import type { MailboxCredentials } from "@/mail/providers/types";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Completes the OAuth flow and stores the mailbox.
 *
 * Only the refresh token is persisted, encrypted at rest like every other
 * credential. The address is read back from the provider rather than trusted
 * from the client, so a mailbox can only ever be connected as the account that
 * actually granted consent.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  if (provider !== "google" && provider !== "microsoft") {
    return NextResponse.json({ error: "Unknown provider." }, { status: 404 });
  }

  const url = new URL(request.url);
  const error = url.searchParams.get("error");
  if (error) return failure(`Authorisation was declined (${error}).`);

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return failure("The provider did not return a code.");

  let workspaceId: string;
  let userId: string;
  try {
    const parsed = JSON.parse(decryptSecret(state)) as {
      workspaceId: string;
      userId: string;
      issuedAt: number;
    };
    // A stale state is a replay or a very slow consent; either way, start over.
    if (Date.now() - parsed.issuedAt > 30 * 60 * 1000) {
      return failure("That authorisation link expired. Please try again.");
    }
    workspaceId = parsed.workspaceId;
    userId = parsed.userId;
  } catch {
    return failure("The authorisation state was invalid.");
  }

  let tokens;
  try {
    tokens = await exchangeCode(provider, code);
  } catch (err) {
    return failure(err instanceof Error ? err.message : String(err));
  }

  if (!tokens.refresh_token) {
    return failure(
      "No refresh token was returned. Remove the app from your account's third-party access and connect again so consent is re-issued.",
    );
  }

  const address = await fetchAuthorizedEmail(provider, tokens.access_token);
  if (!address) {
    return failure("Could not read the authorised email address.");
  }
  const email = normalizeEmail(address);

  const preset = presetFor(provider === "google" ? "gmail" : "outlook");
  const credentials: MailboxCredentials = {
    smtp: { ...preset.smtp, user: email, pass: "" },
    imap: { ...preset.imap, user: email, pass: "" },
    oauth: { provider, refreshToken: tokens.refresh_token },
  };

  const supabase = createSupabaseAdminClient();
  const { error: saveError } = await supabase.from("mailboxes").upsert(
    {
      workspace_id: workspaceId,
      provider: provider === "google" ? "gmail" : "outlook",
      auth_type: "oauth2",
      email,
      encrypted_credentials: encryptJson(credentials),
      is_active: true,
      health_status: "healthy",
      last_error: null,
    },
    { onConflict: "workspace_id,email" },
  );

  if (saveError) return failure(saveError.message);

  await logActivity(supabase, {
    workspaceId,
    actorId: userId,
    action: "mailbox.connected_oauth",
    meta: { email, provider },
  });

  return NextResponse.redirect(`${env.appUrl()}/mailboxes?connected=${encodeURIComponent(email)}`);
}

function failure(message: string) {
  const target = new URL(`${env.appUrl()}/mailboxes`);
  target.searchParams.set("oauth_error", message);
  return NextResponse.redirect(target.toString());
}
