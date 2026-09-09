-- =====================================================================
-- 0022 — Auto-capture provenance on deals.
--
-- When a publisher replies, the inbound poller now reads their rate card and
-- fills the deal automatically (prices per niche, TAT, DA/DR, traffic, spam
-- score, word count, max links, content-by, link type, placement, payment
-- method + terms) — filling only blank fields, never overwriting a value a
-- person set.
--
-- This column records *that* a deal (or specific fields) came from a reply and
-- which line of the email each value was read from, so an auto-filled number is
-- inspectable rather than indistinguishable from a hand-typed one. It is
-- deploy-safe to land after the code: the capture path probes for the column
-- (`dealMetaReady`) and simply skips writing provenance until this runs, while
-- still filling the deal's real columns and its notes block.
--
-- Apply by hand in the Supabase SQL editor (project ref rqztbqxzhykybnejjuba).
-- =====================================================================

alter table public.deals
  add column if not exists meta jsonb not null default '{}'::jsonb;
