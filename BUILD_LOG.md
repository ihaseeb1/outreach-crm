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

---

## Phase 2 — Connect a mailbox, send, and capture replies

**Status:** complete. Build, typecheck, and 32 smoke tests pass.

### What was built

**`MailboxProvider` interface** (`src/mail/providers/types.ts`) — the seam
between the app and however a mailbox actually sends and receives. Phase 2 ships
`SmtpProvider` (nodemailer over SMTP + imapflow over IMAP, authenticated with an
app password). Phase 7 adds Gmail/Microsoft OAuth2 behind the same interface with
no changes to campaigns, warmup, or the inbox. Presets carry the host settings
for Gmail and Outlook so connecting only needs an address and a password.

**Connecting a mailbox.** Credentials are verified against the real SMTP *and*
IMAP servers before anything is stored, then encrypted with AES-256-GCM.
`encrypted_credentials` is revoked from the `authenticated` Postgres role, so a
workspace member cannot select it even by accident. Any number of mailboxes can
be connected — the UI, rotation, and warmup are all N-mailbox, not two.

**Sending** (`src/mail/send.ts`) — the one outbound path, in a deliberate order:
`canSend()` → atomically reserve a slot against the mailbox's daily limit (a
Postgres function, so two concurrent jobs cannot overshoot the cap) → build the
message with the CAN-SPAM footer and `List-Unsubscribe` headers → provider send →
record the message, releasing the reserved slot if the send failed. Campaign
sends, one-off sends, and warmup all go through it.

**Templating.** `{{first_name|there}}` style variables with fallbacks; an unknown
variable renders empty rather than leaking a raw `{{token}}` into a prospect's
inbox. Plain-text-first HTML generation — no images, no tracking pixels, no
marketing chrome, because cold outreach lands better as ordinary mail.

**One-click unsubscribe.** Stateless HMAC-signed links (no table lookup, and a
link cannot be edited to unsubscribe someone else). `GET` suppresses immediately
and shows a confirmation page; `POST` implements RFC 8058 one-click, which is
what puts the native unsubscribe button in Gmail and Outlook. Both also stop any
in-flight sequence for that contact.

**Receiving** (`src/mail/inbound.ts`) — connect, fetch everything above the last
stored UID, process, disconnect. No persistent connections, so it runs inside a
serverless function. UID-based rather than `\Seen`-based, so reading a mail
yourself does not make the poller skip it.

**What reaches the unified inbox.** Only genuine replies from people you actually
emailed. The classifier (`src/mail/inbound-classify.ts`, pure and fully tested)
separates four cases:

| Kind         | Detected by                                              | Where it goes                          |
| ------------ | -------------------------------------------------------- | -------------------------------------- |
| warmup       | signed `X-OCRM-Warmup` header, or sender is one of your own connected mailboxes | warmup tracker only — never the inbox  |
| bounce       | DSN content-type, mailer-daemon/postmaster sender, or bounce subject | suppressed if hard, logged, not in inbox |
| auto-reply   | RFC 3834 `Auto-Submitted`, `X-Autoreply`, OOO subjects    | logged, not in inbox, does *not* pause a sequence |
| reply        | everything else that ties back to outreach we sent        | inbox, and pauses that contact's sequence |

Anything that cannot be tied back to a message we sent — by threading headers or
by "have we ever emailed this address?" — is dropped without being stored, so
your ordinary personal mail never appears.

**Bounce handling.** Hard bounces (5.x.x, or unambiguous permanent wording) are
suppressed automatically and mark the campaign contact as bounced. Soft bounces
(4.x.x) are recorded but not suppressed.

**UI.** Mailboxes page (connect, per-mailbox daily-usage bar, health badge, test
connection, send a real test email, pause/resume, remove) and a Compose page with
live variable preview.

### Files added

```
supabase/migrations/0002_mailboxes_campaigns_messages.sql
src/mail/providers/  types.ts, presets.ts, smtp.ts, index.ts
src/mail/            send.ts, inbound.ts, inbound-classify.ts, poll.ts,
                     template.ts, unsubscribe.ts
src/warmup/inbound.ts       (stub until phase 4)
src/lib/html.ts
src/components/      mailbox-connect-form.tsx, mailbox-actions.tsx, compose-form.tsx
src/app/(app)/       mailboxes/, compose/
src/app/api/         mailboxes/, mailboxes/test/, messages/send/, unsubscribe/,
                     cron/inbound/
```

### Migrations run

`0002_mailboxes_campaigns_messages.sql` — mailboxes, campaigns, sequence_steps,
campaign_contacts, messages, plus the `mailbox_reserve_send` /
`mailbox_release_send` functions. The campaign tables land here (rather than in
phase 3) so the reply handler can already pause a sequence on reply.

### How to test

1. Mailboxes → **Connect a mailbox** → Gmail + App Password. A wrong password
   fails at verification and saves nothing.
2. **Send test email** — check the footer contains your postal address and a
   working unsubscribe link.
3. Click that unsubscribe link → the address appears on the Suppressions page,
   and further sends to it are refused.
4. Compose → pick a contact → confirm the preview resolves `{{first_name}}` →
   send.
5. Reply to that email from the recipient account, then **Poll mailboxes now** on
   the Mailboxes page. The reply is recorded; the contact's pipeline stage moves
   to `replied`.
6. Send yourself mail from an unrelated address and poll again — it is ignored,
   not stored.

### Open items

- Inbound mail is fetched from `INBOX` only. Gmail filters that route replies to
  another label will be missed; phase 5 adds folder configuration if needed.
- Attachments on inbound mail are parsed but not stored (Supabase Storage is
  wired for it in phase 5).
- Microsoft tenants with SMTP AUTH disabled cannot connect until the phase 7
  OAuth2 provider lands. Gmail App Passwords are unaffected.
