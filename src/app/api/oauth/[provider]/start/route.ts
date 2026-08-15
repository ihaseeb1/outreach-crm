import { NextResponse } from "next/server";

import { encryptSecret } from "@/lib/crypto";
import { getSession } from "@/lib/workspace";
import {
  authorizeUrl,
  isOAuthConfigured,
  redirectUri,
} from "@/mail/providers/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Kicks off the OAuth consent flow for Gmail or Microsoft 365. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const { provider } = await params;
  if (provider !== "google" && provider !== "microsoft") {
    return NextResponse.json({ error: "Unknown provider." }, { status: 404 });
  }

  const session = await getSession();
  if (!session) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  if (!isOAuthConfigured(provider)) {
    return NextResponse.json(
      {
        error: `OAuth is not configured for ${provider}. Add the client id and secret to the environment, and register ${redirectUri(provider)} as the redirect URI.`,
      },
      { status: 400 },
    );
  }

  // The state is encrypted, not just signed, so the workspace id is not
  // exposed in a URL that passes through a third party.
  const state = encryptSecret(
    JSON.stringify({
      workspaceId: session.workspace.id,
      userId: session.userId,
      issuedAt: Date.now(),
    }),
  );

  return NextResponse.redirect(authorizeUrl(provider, state));
}
