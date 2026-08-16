import dns from "node:dns/promises";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Free deliverability signals, all from DNS.
 *
 * SPF/DKIM/DMARC come from TXT lookups; blacklist status from public DNSBLs.
 * Several DNSBLs rate-limit hard, so every answer is cached in Postgres for a
 * day and shared across mailboxes on the same domain.
 */

export interface DnsAuthResult {
  spfOk: boolean;
  dkimOk: boolean;
  dmarcOk: boolean;
  detail: {
    spfRecord: string | null;
    dmarcPolicy: string | null;
    dkimSelector: string | null;
    notes: string[];
  };
}

/**
 * Consumer mailbox domains. You cannot publish DNS for these and the provider
 * already authenticates outbound mail, so auth checks against them are
 * meaningless rather than failing.
 */
const PROVIDER_MANAGED_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "hotmail.co.uk",
  "live.com",
  "live.co.uk",
  "msn.com",
  "yahoo.com",
  "yahoo.co.uk",
  "ymail.com",
  "aol.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "gmx.com",
  "gmx.net",
  "zoho.com",
  "yandex.com",
]);

/** Selectors used by the providers people actually connect. */
const DKIM_SELECTORS = [
  "google",
  "selector1",
  "selector2",
  "default",
  "dkim",
  "mail",
  "k1",
  "s1",
  "s2",
  "zoho",
  "protonmail",
];

/**
 * Domain-based blocklists. Deliberately a short list of reputable, free-to-query
 * zones — querying dozens of DNSBLs gets you rate-limited and tells you little.
 */
const DOMAIN_BLOCKLISTS = [
  { zone: "dbl.spamhaus.org", label: "Spamhaus DBL" },
  { zone: "multi.surbl.org", label: "SURBL" },
];

const CACHE_TTL_HOURS = 24;

async function cached<T>(
  supabase: SupabaseClient,
  key: string,
  compute: () => Promise<T>,
): Promise<T> {
  const { data } = await supabase
    .from("dns_check_cache")
    .select("result, expires_at")
    .eq("key", key)
    .maybeSingle();

  const row = data as { result: T; expires_at: string } | null;
  if (row && new Date(row.expires_at) > new Date()) return row.result;

  const result = await compute();
  const expiresAt = new Date(Date.now() + CACHE_TTL_HOURS * 3600 * 1000);

  await supabase
    .from("dns_check_cache")
    .upsert(
      { key, result: result as unknown as Record<string, unknown>, expires_at: expiresAt.toISOString() },
      { onConflict: "key" },
    );

  return result;
}

async function txt(name: string): Promise<string[]> {
  try {
    const records = await dns.resolveTxt(name);
    return records.map((chunks) => chunks.join(""));
  } catch {
    return [];
  }
}

export async function checkAuthRecords(
  supabase: SupabaseClient,
  domain: string,
): Promise<DnsAuthResult> {
  return cached(supabase, `auth:${domain}`, async () => {
    const notes: string[] = [];

    const spfRecords = await txt(domain);
    const spfRecord =
      spfRecords.find((record) => record.toLowerCase().startsWith("v=spf1")) ?? null;
    if (!spfRecord) notes.push("No SPF record found on the sending domain.");

    const dmarcRecords = await txt(`_dmarc.${domain}`);
    const dmarcRecord =
      dmarcRecords.find((record) => record.toLowerCase().startsWith("v=dmarc1")) ?? null;
    const dmarcPolicy =
      /\bp\s*=\s*(none|quarantine|reject)/i.exec(dmarcRecord ?? "")?.[1]?.toLowerCase() ??
      null;
    if (!dmarcRecord) notes.push("No DMARC record found.");
    else if (dmarcPolicy === "none") {
      notes.push("DMARC policy is p=none — monitoring only, not enforcing.");
    }

    // Sending from a consumer mailbox means the provider owns the domain's DNS
    // and signs on your behalf, using dated selectors that rotate and cannot be
    // guessed. Probing for them always comes back empty, which reported every
    // @gmail.com mailbox as "DKIM missing" forever — a permanent warning that
    // no user action could ever clear, and which would mask a real one.
    if (PROVIDER_MANAGED_DOMAINS.has(domain.toLowerCase())) {
      notes.push(
        `${domain} is signed by the provider — SPF, DKIM and DMARC are theirs to publish, and there is nothing to add.`,
      );
      return {
        spfOk: true,
        dkimOk: true,
        dmarcOk: true,
        detail: { spfRecord, dmarcPolicy, dkimSelector: "provider-managed", notes },
      };
    }

    let dkimSelector: string | null = null;
    for (const selector of DKIM_SELECTORS) {
      const records = await txt(`${selector}._domainkey.${domain}`);
      if (records.some((record) => /v=DKIM1|(^|;)\s*p=/i.test(record))) {
        dkimSelector = selector;
        break;
      }
    }
    if (!dkimSelector) {
      notes.push(
        "No DKIM key found on the common selectors — it may use a custom one.",
      );
    }

    return {
      spfOk: Boolean(spfRecord),
      dkimOk: Boolean(dkimSelector),
      dmarcOk: Boolean(dmarcRecord),
      detail: { spfRecord, dmarcPolicy, dkimSelector, notes },
    };
  });
}

export interface BlacklistHit {
  zone: string;
  label: string;
  answer: string;
}

export async function checkBlacklists(
  supabase: SupabaseClient,
  domain: string,
): Promise<BlacklistHit[]> {
  return cached(supabase, `dnsbl:${domain}`, async () => {
    const hits: BlacklistHit[] = [];

    for (const list of DOMAIN_BLOCKLISTS) {
      try {
        const answers = await dns.resolve4(`${domain}.${list.zone}`);
        // 127.0.0.255 and friends signal a query error / rate limit, not a
        // listing — treating those as a listing would falsely pause a mailbox.
        const real = answers.filter((ip) => !ip.startsWith("127.255.255."));
        const listed = real.find((ip) => ip.startsWith("127."));
        if (listed) hits.push({ zone: list.zone, label: list.label, answer: listed });
      } catch {
        // NXDOMAIN is the normal "not listed" answer.
      }
    }

    return hits;
  });
}

/** The domain a mailbox actually sends from. */
export function sendingDomain(email: string): string {
  return email.split("@")[1]?.toLowerCase() ?? "";
}
