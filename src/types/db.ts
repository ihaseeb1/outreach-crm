/**
 * Row shapes for the tables this app touches. Hand-maintained alongside the
 * SQL migrations — when you add a column to a migration, add it here too.
 */

export type Uuid = string;
export type Timestamp = string;

export interface Profile {
  id: Uuid;
  email: string;
  full_name: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface Workspace {
  id: Uuid;
  name: string;
  owner_id: Uuid;
  sending_postal_address: string | null;
  api_key: string;
  settings: Record<string, unknown>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type ScrapeJobStatus = "pending" | "running" | "completed" | "failed";

export interface ScrapeJob {
  id: Uuid;
  workspace_id: Uuid;
  created_by: Uuid | null;
  input_urls: string[];
  status: ScrapeJobStatus;
  total_count: number;
  processed_count: number;
  found_count: number;
  error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  completed_at: Timestamp | null;
}

export type WebsiteStatus =
  | "pending"
  | "scraping"
  | "done"
  | "failed"
  | "skipped_robots";

export interface Website {
  id: Uuid;
  workspace_id: Uuid;
  scrape_job_id: Uuid | null;
  url: string;
  domain: string;
  status: WebsiteStatus;
  http_status: number | null;
  emails_found: number;
  error: string | null;
  meta: WebsiteMeta;
  scraped_at: Timestamp | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface WebsiteMeta {
  title?: string;
  description?: string;
  phones?: string[];
  social?: Record<string, string>;
  pages_crawled?: string[];
  [key: string]: unknown;
}

export type ValidationStatus =
  | "unknown"
  | "valid"
  | "invalid_syntax"
  | "no_mx"
  | "disposable"
  | "role_account"
  | "suppressed"
  | "bounced";

export interface Contact {
  id: Uuid;
  workspace_id: Uuid;
  website_id: Uuid | null;
  email: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  website: string | null;
  domain: string | null;
  source_url: string | null;
  scraped_at: Timestamp | null;
  validation_status: ValidationStatus;
  validated_at: Timestamp | null;
  pipeline_stage: string;
  tags: string[];
  meta: Record<string, unknown>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type SuppressionReason =
  | "unsubscribed"
  | "hard_bounce"
  | "complaint"
  | "manual"
  | "opted_out";

export interface Suppression {
  id: Uuid;
  workspace_id: Uuid;
  email: string;
  reason: SuppressionReason;
  source: string | null;
  meta: Record<string, unknown>;
  created_at: Timestamp;
}

export type MailboxHealthStatus = "healthy" | "warning" | "paused";

export interface Mailbox {
  id: Uuid;
  workspace_id: Uuid;
  provider: "smtp" | "gmail" | "outlook";
  auth_type: "app_password" | "oauth2";
  email: string;
  from_name: string | null;
  daily_limit: number;
  sent_today: number;
  sent_today_date: string;
  min_gap_seconds: number;
  max_gap_seconds: number;
  is_active: boolean;
  health_status: MailboxHealthStatus;
  paused_reason: string | null;
  signature: string | null;
  imap_last_uid: number | null;
  last_polled_at: Timestamp | null;
  last_send_at: Timestamp | null;
  last_error: string | null;
  meta: Record<string, unknown>;
  created_at: Timestamp;
  updated_at: Timestamp;
  /** Only ever present on the server. */
  encrypted_credentials?: string | null;
}

export type CampaignStatus =
  | "draft"
  | "active"
  | "paused"
  | "completed"
  | "archived";

export interface Campaign {
  id: Uuid;
  workspace_id: Uuid;
  name: string;
  status: CampaignStatus;
  mailbox_ids: Uuid[];
  settings: CampaignSettings;
  created_by: Uuid | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CampaignSettings {
  /** Local hours during which sends are allowed, e.g. 9–17. */
  send_window_start?: number;
  send_window_end?: number;
  /** 0 = Sunday. Defaults to Mon–Fri. */
  send_days?: number[];
  timezone?: string;
  [key: string]: unknown;
}

export interface SequenceStep {
  id: Uuid;
  campaign_id: Uuid;
  step_number: number;
  delay_days: number;
  subject_template: string;
  body_template: string;
  reply_to_thread: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type CampaignContactStatus =
  | "pending"
  | "active"
  | "replied"
  | "completed"
  | "paused"
  | "bounced"
  | "unsubscribed"
  | "failed";

export interface CampaignContact {
  id: Uuid;
  campaign_id: Uuid;
  contact_id: Uuid;
  workspace_id: Uuid;
  current_step: number;
  status: CampaignContactStatus;
  next_send_at: Timestamp | null;
  mailbox_id: Uuid | null;
  thread_id: string | null;
  last_sent_at: Timestamp | null;
  replied_at: Timestamp | null;
  paused_reason: string | null;
  /** Claim lock held by the campaign runner; self-expires. */
  locked_until: Timestamp | null;
  attempts: number;
  last_error: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface Message {
  id: Uuid;
  workspace_id: Uuid;
  campaign_id: Uuid | null;
  contact_id: Uuid | null;
  mailbox_id: Uuid | null;
  direction: "outbound" | "inbound";
  step_number: number | null;
  from_email: string | null;
  to_email: string | null;
  subject: string | null;
  body: string | null;
  body_html: string | null;
  message_id: string | null;
  in_reply_to: string | null;
  thread_id: string | null;
  status: "queued" | "sent" | "failed" | "received" | "bounced";
  is_bounce: boolean;
  is_auto_reply: boolean;
  error: string | null;
  meta: Record<string, unknown>;
  sent_at: Timestamp | null;
  received_at: Timestamp | null;
  created_at: Timestamp;
}

export interface ActivityLogEntry {
  id: Uuid;
  workspace_id: Uuid;
  actor_id: Uuid | null;
  action: string;
  entity_type: string | null;
  entity_id: Uuid | null;
  meta: Record<string, unknown>;
  created_at: Timestamp;
}
