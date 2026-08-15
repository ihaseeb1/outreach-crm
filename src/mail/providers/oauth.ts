import { env } from "@/lib/env";
import type { OAuthCredentials } from "@/mail/providers/types";

/**
 * OAuth2 token handling for Gmail and Microsoft 365.
 *
 * Only the refresh token is stored (encrypted). Access tokens are fetched on
 * demand and cached in memory for the life of the function invocation, which is
 * short — that is the right trade for a serverless runtime and avoids keeping
 * more secrets at rest than necessary.
 */

export interface OAuthProviderConfig {
  authUrl: string;
  tokenUrl: string;
  scopes: string[];
  clientId: () => string;
  clientSecret: () => string;
  /** Endpoint that reveals which address the user just authorised. */
  identityUrl: string;
  identityField: (payload: Record<string, unknown>) => string | null;
}

export const OAUTH_PROVIDERS: Record<"google" | "microsoft", OAuthProviderConfig> = {
  google: {
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: [
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    clientId: () => required("GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: () => required("GOOGLE_OAUTH_CLIENT_SECRET"),
    identityUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
    identityField: (payload) =>
      typeof payload.email === "string" ? payload.email : null,
  },
  microsoft: {
    authUrl: `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize`,
    tokenUrl: `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`,
    scopes: [
      "offline_access",
      "https://outlook.office.com/SMTP.Send",
      "https://outlook.office.com/IMAP.AccessAsUser.All",
      "User.Read",
    ],
    clientId: () => required("MICROSOFT_OAUTH_CLIENT_ID"),
    clientSecret: () => required("MICROSOFT_OAUTH_CLIENT_SECRET"),
    identityUrl: "https://graph.microsoft.com/v1.0/me",
    identityField: (payload) => {
      const mail = payload.mail ?? payload.userPrincipalName;
      return typeof mail === "string" ? mail : null;
    },
  },
};

function tenant(): string {
  return process.env.MICROSOFT_TENANT_ID || "common";
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. OAuth for this provider is not configured — see BUILD_LOG.md, "NEEDS FROM USER".`,
    );
  }
  return value;
}

export function isOAuthConfigured(provider: "google" | "microsoft"): boolean {
  return provider === "google"
    ? Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET)
    : Boolean(
        process.env.MICROSOFT_OAUTH_CLIENT_ID &&
          process.env.MICROSOFT_OAUTH_CLIENT_SECRET,
      );
}

export function redirectUri(provider: string): string {
  return `${env.appUrl()}/api/oauth/${provider}/callback`;
}

export function authorizeUrl(
  provider: "google" | "microsoft",
  state: string,
): string {
  const config = OAUTH_PROVIDERS[provider];
  const params = new URLSearchParams({
    client_id: config.clientId(),
    redirect_uri: redirectUri(provider),
    response_type: "code",
    scope: config.scopes.join(" "),
    state,
    // Both are required to get a refresh token back from Google.
    access_type: "offline",
    prompt: "consent",
  });
  return `${config.authUrl}?${params.toString()}`;
}

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export async function exchangeCode(
  provider: "google" | "microsoft",
  code: string,
): Promise<TokenResponse> {
  const config = OAUTH_PROVIDERS[provider];
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId(),
      client_secret: config.clientSecret(),
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri(provider),
    }),
  });

  const payload = (await response.json()) as TokenResponse;
  if (!response.ok || payload.error) {
    throw new Error(
      payload.error_description ?? payload.error ?? "Token exchange failed.",
    );
  }
  return payload;
}

/** Cached per process; invocations are short-lived so this stays small. */
const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function accessTokenFor(
  credentials: OAuthCredentials,
): Promise<string> {
  const key = `${credentials.provider}:${credentials.refreshToken.slice(-16)}`;
  const cached = accessTokenCache.get(key);
  // 60s of slack so a token cannot expire mid-send.
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const config = OAUTH_PROVIDERS[credentials.provider];
  const response = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.clientId(),
      client_secret: config.clientSecret(),
      refresh_token: credentials.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const payload = (await response.json()) as TokenResponse;
  if (!response.ok || !payload.access_token) {
    throw new Error(
      payload.error_description ??
        payload.error ??
        "Could not refresh the access token — the mailbox may need reconnecting.",
    );
  }

  const expiresAt = Date.now() + (payload.expires_in ?? 3600) * 1000;
  accessTokenCache.set(key, { token: payload.access_token, expiresAt });
  return payload.access_token;
}

export async function fetchAuthorizedEmail(
  provider: "google" | "microsoft",
  accessToken: string,
): Promise<string | null> {
  const config = OAUTH_PROVIDERS[provider];
  const response = await fetch(config.identityUrl, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  const payload = (await response.json()) as Record<string, unknown>;
  return config.identityField(payload);
}
