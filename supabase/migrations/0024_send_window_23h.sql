-- 0024: 23-hour send window (1 AM - midnight) + tighter send gaps
--
-- The user configured campaigns for 1:00-24:00 but the engine was running
-- 9:00-17:00 (8h). With 15-45 min inter-send gaps, 40/day was mathematically
-- unreachable in 8 hours (max ~16). This migration:
-- 1. Sets all campaigns to 1 AM - midnight (23-hour window)
-- 2. Tightens mailbox send gaps to 5-12 min so 40/day is comfortably reachable
--    in the 23-hour window (capacity ~160/day, target 40/day)

-- 1. Campaigns: 1 AM to midnight
UPDATE campaigns
SET settings = jsonb_set(
  jsonb_set(
    COALESCE(settings, '{}'::jsonb),
    '{send_window_start}',
    '1'::jsonb
  ),
  '{send_window_end}',
  '24'::jsonb
);

-- 2. Mailboxes: 5-12 minute gaps (300-720 seconds)
-- 23h window / 8.5 min avg gap = ~162 sends capacity, well above 40/day target
UPDATE mailboxes
SET min_gap_seconds = 300,
    max_gap_seconds = 720;
