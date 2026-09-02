/**
 * Row shapes for the tables this app touches. Hand-maintained alongside the
 * SQL migrations — when you add a column to a migration, add it here too.
 */

export type Uuid = string;
export type Timestamp = string;

export type AccountStatus = "pending" | "active" | "rejected" | "banned";
export type AppRole = "super_admin" | "admin" | "member";

export interface Profile {
  id: Uuid;
  email: string;
  full_name: string | null;
  status: AccountStatus;
  app_role: AppRole;
  approved_at: Timestamp | null;
  approved_by: Uuid | null;
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
  /** Soft delete (migration 0010); absent on older rows. */
  deleted_at?: Timestamp | null;
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
  | "safe"
  | "catch_all"
  | "invalid"
  | "invalid_syntax"
  | "no_mx"
  | "disposable"
  | "spamtrap"
  | "disabled"
  | "inbox_full"
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
  /** Soft-delete (spec §8): set = archived/hidden from the working list. */
  archived_at?: Timestamp | null;
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
  /** Warmup pacing/rotation clocks (migrations 0014, 0015). */
  last_warmup_at?: Timestamp | null;
  last_engaged_at?: Timestamp | null;
  last_purged_at?: Timestamp | null;
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
  /** Warmup flag (migration 0015). Set from `kind` at insert and by the
   * pool-membership backfill; the deletion job re-checks the pool anyway. */
  is_warmup: boolean;
  error: string | null;
  meta: Record<string, unknown>;
  sent_at: Timestamp | null;
  received_at: Timestamp | null;
  /** Soft delete (migration 0015); a later pass hard-deletes past the grace. */
  deleted_at?: Timestamp | null;
  created_at: Timestamp;
}

export interface WarmupSettings {
  id: Uuid;
  mailbox_id: Uuid;
  workspace_id: Uuid;
  enabled: boolean;
  current_daily_volume: number;
  target_daily_volume: number;
  ramp_increment: number;
  reply_rate: number;
  last_ramped_on: string | null;
  started_at: Timestamp | null;
  /** Per-mailbox retention override (migration 0015); null = inherit workspace
   * default. Values match RetentionRule in src/warmup/deletion.ts. */
  delete_after?: "today" | "7d" | "14d" | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface MailboxHealth {
  id: Uuid;
  mailbox_id: Uuid;
  workspace_id: Uuid;
  date: string;
  reputation_score: number;
  sent_7d: number;
  bounce_rate: number;
  complaint_rate: number;
  reply_rate: number;
  warmup_spam_rate: number;
  spf_ok: boolean | null;
  dkim_ok: boolean | null;
  dmarc_ok: boolean | null;
  dns_detail: Record<string, unknown>;
  blacklists: string[];
  status: MailboxHealthStatus;
  issues: string[];
  checked_at: Timestamp;
}

export interface Conversation {
  id: Uuid;
  workspace_id: Uuid;
  contact_id: Uuid;
  mailbox_id: Uuid | null;
  subject: string | null;
  last_message_at: Timestamp;
  last_direction: "inbound" | "outbound" | null;
  is_read: boolean;
  assigned_to: Uuid | null;
  status: "open" | "snoozed" | "closed";
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type DealStatus =
  | "negotiating"
  | "agreed"
  | "ordered"
  | "live"
  | "rejected";

export interface Deal {
  id: Uuid;
  workspace_id: Uuid;
  contact_id: Uuid | null;
  conversation_id: Uuid | null;
  domain: string;
  link_type: string | null;
  placement_type: string | null;
  tat_days: number | null;
  da: number | null;
  dr: number | null;
  monthly_traffic: number | null;
  spam_score: number | null;
  word_count: number | null;
  content_by: string | null;
  max_links: number | null;
  payment_terms: string | null;
  payment_method: string | null;
  currency: string;
  status: DealStatus;
  notes: string | null;
  /** Link-building placement tracker (spec §9, migration 0012). */
  placed_url?: string | null;
  target_url?: string | null;
  anchor_text?: string | null;
  link_status?: "unchecked" | "found" | "missing" | "error";
  link_is_dofollow?: boolean | null;
  link_checked_at?: Timestamp | null;
  link_detail?: string | null;
  created_by: Uuid | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface DealPrice {
  id: Uuid;
  deal_id: Uuid;
  niche: string;
  price: number;
  currency: string;
  created_at: Timestamp;
}

export interface DealWithPrices extends Deal {
  deal_prices: DealPrice[];
}

export interface PipelineStage {
  id: Uuid;
  workspace_id: Uuid;
  key: string;
  label: string;
  position: number;
  color: string;
  is_won: boolean;
  is_lost: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface Note {
  id: Uuid;
  workspace_id: Uuid;
  contact_id: Uuid | null;
  domain: string | null;
  author_id: Uuid | null;
  body: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface Task {
  id: Uuid;
  workspace_id: Uuid;
  contact_id: Uuid | null;
  deal_id: Uuid | null;
  title: string;
  details: string | null;
  due_date: string | null;
  done: boolean;
  done_at: Timestamp | null;
  assigned_to: Uuid | null;
  created_by: Uuid | null;
  created_at: Timestamp;
  updated_at: Timestamp;
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

// =====================================================================
// Discovery & Prospecting (migration 0016) — all additive.
// =====================================================================

/** Where a discovered site or active author sits in the outreach lifecycle. */
export type RelationshipStage =
  | "new"
  | "contacted"
  | "replied"
  | "published"
  | "won";

export type DiscoveryRunStatus = "pending" | "running" | "completed" | "failed";

export interface DiscoveryRun {
  id: Uuid;
  workspace_id: Uuid;
  created_by: Uuid | null;
  niche: string;
  queries: string[];
  /** ISO-3166 alpha-2 code, or "WORLDWIDE". */
  geo: string;
  engines: string[];
  status: DiscoveryRunStatus;
  total_queries: number;
  processed_queries: number;
  found_count: number;
  error: string | null;
  settings: Record<string, unknown>;
  created_at: Timestamp;
  updated_at: Timestamp;
  completed_at: Timestamp | null;
}

export interface DiscoveredSite {
  id: Uuid;
  workspace_id: Uuid;
  run_id: Uuid;
  root_domain: string;
  guest_post_url: string | null;
  matched_footprint: string | null;
  best_position: number | null;
  title: string | null;
  description: string | null;
  opportunity_score: number | null;
  post_cadence_days: number | null;
  has_contact_info: boolean;
  status: RelationshipStage;
  pushed_website_id: Uuid | null;
  pushed_at: Timestamp | null;
  /** Author-crawl seed fields (migration 0017). */
  author_crawl?: boolean;
  authors_crawled_at?: Timestamp | null;
  authors_found?: number;
  meta: Record<string, unknown>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type AuthorEmailStatus =
  | "unknown"
  | "verified"
  | "invalid_syntax"
  | "no_mx"
  | "disposable"
  | "role_account"
  | "unverified";

export interface ActiveAuthor {
  id: Uuid;
  workspace_id: Uuid;
  source_domain: string;
  source_post_url: string;
  author_name: string | null;
  destination_domain: string;
  published_at: Timestamp | null;
  detection_score: number | null;
  freshness_score: number | null;
  latest_post_title: string | null;
  latest_post_topic: string | null;
  email: string | null;
  email_status: AuthorEmailStatus;
  phone: string | null;
  phone_region: string | null;
  contact_confidence: number | null;
  status: RelationshipStage;
  /** Enrichment claim stamp (migration 0018). */
  enriched_at?: Timestamp | null;
  meta: Record<string, unknown>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface CrawlCacheRow {
  url: string;
  status_int: number | null;
  body: string | null;
  fetched_at: Timestamp;
  ttl_seconds: number;
}

export type SuppressionListKind = "domain" | "email";
export type SuppressionListReason =
  | "competitor"
  | "owned"
  | "unsubscribed"
  | "bounced"
  | "manual";

export interface SuppressionListEntry {
  id: Uuid;
  workspace_id: Uuid;
  value: string;
  kind: SuppressionListKind;
  reason: SuppressionListReason;
  meta: Record<string, unknown>;
  created_at: Timestamp;
}
