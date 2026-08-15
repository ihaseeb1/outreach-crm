# Build log

Running record of what each phase delivered, how to test it, and what is
outstanding. Newest phase at the bottom.

---

## NEEDS FROM USER

Nothing here blocks further phases — each item is needed to *run* the feature,
not to build it. Everything below can be filled in whenever you are ready.

1. **Supabase project + keys** (needed to run anything).
   Create a free project, then put the Project URL, `anon` key, and
   `service_role` key into `.env.local`. Run every file in
   `supabase/migrations/` in the SQL Editor, in filename order.
2. **Two generated secrets** for `.env.local` — `CRON_SECRET` and
   `APP_ENCRYPTION_KEY` (command in README).
3. **Sending postal address** — enter it in Settings. Campaigns are hard-blocked
   from sending until it is set (CAN-SPAM).
4. **Gmail App Password** (phase 2) — for each mailbox you want to send from,
   enable 2FA on the Google account and create an App Password. Phase 2 sends
   over SMTP with it; phase 7 adds OAuth2 as an alternative.
5. **A scheduler** (phase 1 onward, needed for anything automatic).
   Vercel Hobby only fires cron once a day. Point cron-job.org (or GitHub
   Actions) at `/api/cron/tick` every 5–10 minutes with the
   `Authorization: Bearer $CRON_SECRET` header. Until then, use the "Run a batch
   now" buttons in Prospecting.

### Design defaults chosen (change any of these freely)

| Decision                | Default                                              |
| ----------------------- | ---------------------------------------------------- |
| Project location        | `C:\Users\ihase\outreach-crm`                        |
| Workspaces per user     | One, created automatically by a signup trigger       |
| Pages crawled per site  | 5 (homepage + contact/about/write-for-us pages)      |
| Crawl delay floor       | 1500 ms, or robots.txt `Crawl-delay` if longer       |
| Role accounts           | Tracked separately but treated as sendable           |
| Un-suppressing          | Allowed for manual/unsubscribed; blocked for bounces and complaints |

---

## Phase 1 — Foundation, scraper, list builder, validation, compliance core

**Status:** complete. `npm run build`, `npm run typecheck`, and `npm run smoke`
(18 tests) all pass.

### What was built

**Scaffold.** Next.js 15 App Router + TypeScript (strict, with
`noUncheckedIndexedAccess`) + Tailwind v4. Supabase SSR auth wired through
middleware so every non-public route requires a session.

**Database (migration `0001`).** Identity (`profiles`, `workspaces`,
`workspace_members`), prospecting (`scrape_jobs`, `websites`, `contacts`), and
the compliance core (`suppressions`, `activity_log`). RLS is on for every table;
access is granted by `is_workspace_member()`, a `SECURITY DEFINER` helper that
avoids policy recursion. A signup trigger creates the profile, workspace, and
owner membership in one transaction.

**Scraper.** `Scraper` interface with a `StaticScraper` (fetch + cheerio)
implementation, so a Playwright version can slot in at phase 7 without touching
callers. Per site: fetch and parse robots.txt, honour Disallow rules and
`Crawl-delay` (floored at our own politeness delay), crawl the homepage plus up
to four contact-ish pages, and extract emails (mailto, plain text, and
`[at]`/`[dot]` obfuscation), phones, title, description, and social links.
Aggressive junk filtering strips asset filenames, tracking IDs, and placeholder
domains. Contacts are deduped per workspace and stamped with `source_url` and
`scraped_at` for GDPR accountability.

**Validation.** Syntax (`validator`) + MX (`dns.resolveMx`, cached per run) +
disposable-domain blocklist (~450 domains, extendable via
`DISPOSABLE_DOMAINS_EXTRA`). Deliberately no SMTP handshake probing — it gets IPs
blocked and lies about catch-alls; real deliverability is confirmed by bounce
handling in phase 3. Suppressed addresses always win over a DNS verdict.

**Compliance core.** `canSend()` in `src/mail/guard.ts` is the single gate every
future send path must pass through. It rejects empty/invalid addresses,
disposable domains, anything on `suppressions`, and — for campaign mail — any
workspace without a postal address. `suppressEmail()` is the one writer to the
list; it also mirrors the state onto the contact. Hard bounces and complaints
cannot be un-suppressed through the UI.

**Jobs.** Every job is a bounded, idempotent batch. Websites are claimed with a
conditional `pending -> scraping` update so overlapping ticks cannot
double-process a row. `/api/cron/tick` is a single dispatcher that runs a slice
of every job — this exists because Vercel Hobby only triggers cron once a day, so
any free external scheduler can drive the real cadence instead.

**UI.** Login/signup, dashboard with counters and a live compliance checklist,
Prospecting (paste or upload URLs, job progress, website results, run-a-batch-now
buttons), Contacts (filter by email/domain/validation status, paginated, CSV
export honouring the filters), Suppressions (add in bulk, remove where allowed),
and Settings (workspace name, postal address, API key, cron endpoints).

### Files added

```
supabase/migrations/0001_core_identity_prospecting_compliance.sql
src/lib/           env.ts, crypto.ts, cron.ts, activity.ts, email.ts, workspace.ts
src/lib/supabase/  client.ts, server.ts, admin.ts, middleware.ts
src/mail/          guard.ts (canSend), suppressions.ts
src/scraper/       types.ts, static-scraper.ts, robots.ts, extract.ts, run.ts
src/validation/    disposable.ts, validate.ts, run.ts
src/types/db.ts
src/middleware.ts
src/components/    nav.tsx, url-import-form.tsx, run-job-button.tsx, suppression-form.tsx
src/app/           layout.tsx, page.tsx, globals.css, login/, signup/, auth/signout/
src/app/(app)/     layout.tsx, dashboard/, prospecting/, contacts/, suppressions/, settings/
src/app/api/       scrape-jobs/, contacts/export/, suppressions/, jobs/run/,
                   cron/{tick,scrape,validate}/
scripts/smoke-test.ts
README.md, .env.example, vercel.json
```

### Migrations run

`0001_core_identity_prospecting_compliance.sql` — must be executed manually in
the Supabase SQL Editor (see NEEDS FROM USER).

### How to test

```bash
npm install
npm run smoke        # 18 pure-logic tests, no network or DB needed
npm run typecheck
npm run build
npm run dev
```

Then, against a real Supabase project:

1. Sign up at `/signup` — confirm a workspace was created for you.
2. Settings → save a postal address.
3. Prospecting → paste a few real publisher URLs → **Queue scrape job**.
4. Click **Scrape next 5 websites**, then **Validate next 100 emails**.
5. Contacts → filter by "Valid", export CSV.
6. Suppressions → add one of the scraped addresses, then re-run validation and
   confirm that contact flips to `suppressed`.

Cron endpoints, tested by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/tick
```

### Open items

- Robots handling treats a 5xx on `/robots.txt` as "absent" (allow). Stricter
  crawlers back off instead; revisit if a publisher complains.
- Contact-page discovery is keyword-based on the URL path. Sites that hide
  contact details behind JS forms need the phase 7 Playwright scraper.
- No test for `runScrapeBatch`/`runValidationBatch` end-to-end yet — they need a
  live database. Their pure pieces are covered.
