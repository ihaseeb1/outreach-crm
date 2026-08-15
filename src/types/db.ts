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
