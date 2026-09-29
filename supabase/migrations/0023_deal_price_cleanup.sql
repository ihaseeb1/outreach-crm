-- =====================================================================
-- 0023 — Clean up deal_prices: fixed taxonomy + drop absurd prices.
--
-- Background: the rate-card parser used to file a price under the publisher's
-- raw label ("30 Days Footer Text Link", "Casino & Gambling blogs", …), and the
-- deals table rendered one column per distinct label — hundreds of junk
-- columns. It also accepted any amount, so misreads like "USD 90,028" landed
-- on deals.
--
-- The parser now canonicalizes every price into a fixed 22-value taxonomy
-- (src/deals/parse-quote.ts CANONICAL_NICHES) and rejects amounts over
-- MAX_SANE_PRICE (20,000). This migration brings the existing rows into the
-- same shape:
--
--   1. Deletes prices above the sanity cap (misreads/typos — kept nowhere).
--   2. Remaps every remaining niche label to the canonical taxonomy via
--      keyword matching that mirrors the parser's aliases. Unrecognised
--      labels become 'General'; the price is kept and the original wording
--      survives in the deal's auto-capture notes block.
--   3. Dedupes: if two rows on one deal remap to the same category, the
--      earliest-created row wins (first read wins, like the app's own rule)
--      and the later duplicates are deleted.
--
-- Safe to re-run: after the first run every niche is already canonical and the
-- remap is a no-op; the absurd-price delete only ever matches new junk.
-- Apply by hand in the Supabase SQL editor (project ref rqztbqxzhykybnejjuba),
-- like 0022.
-- =====================================================================

-- 1. Absurd prices: a per-link price above the cap is a misread or a typo.
-- (Mirrors MAX_SANE_PRICE in src/deals/parse-quote.ts — keep them in sync.)
delete from public.deal_prices where price > 20000;

-- 2. Keyword → canonical category, mirroring the parser's alias tiers:
-- restricted subjects first, then products, then named subjects, then General.
create or replace function public.canonical_deal_niche(label text)
returns text
language sql
immutable
as $$
  select case
    -- Restricted subjects (priced punitively; win over everything else)
    when l ~ 'casino|gambl|poker|igaming|sportsbook|(^|[^a-z])bets?([^a-z]|$)|(^|[^a-z])slot([^a-z]|$)' then 'Casino'
    when l ~ 'cbd|cannabis|marijuana|weed|hemp|vape|kratom' then 'CBD'
    when l ~ 'crypto|bitcoin|blockchain|nft|web ?3' then 'Crypto'
    when l ~ 'adult|porn|escort|xxx' then 'Adult'
    when l ~ 'dating|hookup' then 'Dating'
    -- Products (publishers price these alongside niches)
    when l ~ 'niche edits?' then 'Niche edit'
    when l ~ 'link insertion|link placement|contextual link' then 'Link insertion'
    when l ~ 'footer' then 'Footer text link'
    when l ~ 'homepage|home page' then 'Homepage link'
    when l ~ 'banner|sidebar' then 'Banner'
    when l ~ 'press release' then 'Press release'
    -- Named subjects
    when l ~ 'finance|financial|insurance|(^|[^a-z])loans?([^a-z]|$)|banking|mortgage|forex|trading' then 'Finance'
    when l ~ 'health|medical|medicine|pharma|fitness|wellness|nutrition|supplement' then 'Health'
    when l ~ '(^|[^a-z])law([^a-z]|$)|legal|lawyer|attorney' then 'Legal'
    when l ~ 'real estate|property' then 'Real estate'
    when l ~ 'travel|tourism' then 'Travel'
    when l ~ 'education|(^|[^a-z])edu([^a-z]|$)' then 'Education'
    when l ~ 'tech|technology|software|saas|gadget|(^|[^a-z])ai([^a-z]|$)' then 'Tech'
    when l ~ 'business|marketing|(^|[^a-z])seo([^a-z]|$)|startup|b2b' then 'Business'
    when l ~ '(^|[^a-z])home([^a-z]|$)|garden|interior|decor' then 'Home'
    -- "General" means no particular niche; anything else unrecognised lands
    -- here too rather than inventing a new category.
    else 'General'
  end
  from (select lower(label) as l) s
$$;

-- 3. Remap + dedupe, earliest row wins. Processed in created order so the
-- first row to claim a canonical category keeps it; later rows that would
-- collide are deleted. The unique (deal_id, niche) index can never be
-- violated: we only rename into a category no row on that deal holds yet.
do $$
declare
  r record;
  target text;
begin
  for r in
    select id, deal_id, niche
    from public.deal_prices
    order by deal_id, created_at, id
  loop
    target := public.canonical_deal_niche(r.niche);
    if target is distinct from r.niche then
      if exists (
        select 1 from public.deal_prices q
        where q.deal_id = r.deal_id and q.niche = target
      ) then
        delete from public.deal_prices where id = r.id;
      else
        update public.deal_prices set niche = target where id = r.id;
      end if;
    end if;
  end loop;
end
$$;
