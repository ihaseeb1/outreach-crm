import type { ImapConfig, SmtpConfig } from "@/mail/providers/types";

/**
 * Known host settings so connecting a Gmail or Outlook mailbox only needs an
 * address and an app password.
 */

export type ProviderKey = "gmail" | "outlook" | "smtp";

export interface ProviderPreset {
  label: string;
  smtp: Omit<SmtpConfig, "user" | "pass">;
  imap: Omit<ImapConfig, "user" | "pass">;
  help: string;
}

export const PROVIDER_PRESETS: Record<ProviderKey, ProviderPreset> = {
  gmail: {
    label: "Gmail / Google Workspace",
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    help:
      "Turn on 2-Step Verification, then create an App Password at " +
      "myaccount.google.com/apppasswords and paste it below. IMAP must be " +
      "enabled in Gmail settings.",
  },
  outlook: {
    label: "Outlook / Microsoft 365",
    smtp: { host: "smtp-mail.outlook.com", port: 587, secure: false },
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    help:
      "Microsoft is retiring basic auth for many tenants — if SMTP AUTH is " +
      "disabled on yours, use the OAuth2 option added in phase 7.",
  },
  smtp: {
    label: "Other (custom SMTP/IMAP)",
    smtp: { host: "", port: 465, secure: true },
    imap: { host: "", port: 993, secure: true },
    help: "Enter the host and port your provider documents.",
  },
};

export function presetFor(key: string): ProviderPreset {
  return PROVIDER_PRESETS[(key as ProviderKey) in PROVIDER_PRESETS ? (key as ProviderKey) : "smtp"];
}

/** Gmail free accounts cap at 500/day; Workspace at 2,000. */
export const DEFAULT_DAILY_LIMIT = 50;
