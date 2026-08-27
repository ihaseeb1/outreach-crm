# Handover — 17, 20, 21, 27, 28 August 2026

Read this first, then `DEPLOY_STATUS.md` for hosting and `BUILD_LOG.md` for the
original seven build phases.

---

## Phase 3b §8 — contact archive + lifecycle filters + campaign cleanup, 28 August (seventh session)

Deployed to `main`. Typecheck clean, smoke **323/0**, build clean. **Needs
migration `0011_contact_archive.sql`** — hand-apply in Supabase (project ref
`rqztbqxzhykybnejjuba`). The code is deploy-safe before it runs: readers probe
for the `archived_at` column and only apply the archive filter when it exists,
so the Contacts list keeps working; the archive button returns a clear "apply
migration 0011" message until then.

§8 splits into three, two of which were genuinely missing:

- **Contact archive / soft-delete** — `contacts.archived_at` (0011). Archiving
  hides a contact from the working list *and* stops any live sequence (batched
  `pending`/`active` → `completed`, `paused_reason = "Contact archived"`), but
  keeps the record and its history — the reversible opposite of the permanent
  DELETE. `POST /api/contacts/archive` (`{ids, archived}`) archives or restores;
  `src/lib/contact-archive.ts` holds the column probe + `parseArchiveView`. The
  Contacts table gains **Archive selected** / **Restore selected**, and Delete
  is reworded **Delete permanently**. A **Show: Active / Archived / All** filter
  (defaults to Active) appears once 0011 is applied.
- **Lifecycle filters** — the Contacts filter form gains a **Lifecycle** select
  over the workspace's pipeline stages (New → Contacted → Replied → … → Not a
  fit), backed by the already-indexed `contacts.pipeline_stage`. Export honours
  it too (the export route already accepted `stage`).
- **One-click campaign cleanup** — already existed as `CampaignPurgeButton`
  (bounced + failed). Extended: a **"also finished & opted-out"** toggle adds
  `completed` + `unsubscribed`, so a finished campaign clears in one click. The
  removable-status set now lives in `src/campaigns/cleanup.ts` (`cleanupStatuses`
  / `isCleanable`), shared by the button and the DELETE route so they can never
  disagree — and a live sequence is still impossible to purge.

**Check live after applying 0011:** on Contacts, select a row → **Archive
selected** hides it (and stops its sequence); the **Show** filter flips to
**Archived** to find it → **Restore selected** brings it back. The **Lifecycle**
select filters by stage. On a campaign, tick **also finished & opted-out** →
the cleanup button clears completed/opted-out enrolments too.

**Remaining build-spec work:** §7 crawler hardening + robots toggle, §9
link-building placement tracker + live backlink verifier.

---

## Phase 3a §6 — delete scrape jobs, 28 August (sixth session)

Deployed to `main`. **Migration `0010_scrape_job_soft_delete.sql`** — APPLIED.
`scrape_jobs.deleted_at` (soft delete). `DELETE /api/scrape-jobs` (owner/admin,
single + bulk) soft-deletes the job, removes its raw website rows (contacts
kept via `websites.on delete set null`), optionally removes contacts that came
only from those jobs and were never enrolled; falls back to hard delete if 0010
is absent; audit-logged. The scrape cron hard-purges jobs deleted > 30 days ago.
Prospecting shows `ScrapeJobsTable` (per-row + bulk delete + a "remove
never-contacted contacts" toggle). Deleted jobs are filtered in JS (dashboard
too) so no query references `deleted_at` before the migration.

**Migrations 0008 + 0009 + 0010 are all APPLIED** (Supabase project ref
`rqztbqxzhykybnejjuba` — the live app DB; do not confuse with any other
project). So Phase 1 (heartbeat), Phase 2 (roles/approval + session fix) and §6
are fully live. **Remaining build-spec work:** §8 contact archive/cleanup, §7
crawler hardening + robots toggle, §9 link-building placement tracker.

---

## Phase 2 of the build spec, 28 August (sixth session)

Deployed to `main`. Typecheck clean, smoke 319/0, build clean. **Needs migration
`0009_roles_approval.sql`** — hand-apply in Supabase. Code falls back to
`active`/`member` when the new columns are absent, so this deploy is safe to
land first; the gate turns on when 0009 runs.

§5 **Roles + approval gate.** `profiles` gains `status`
(pending/active/rejected/banned) and `app_role`
(super_admin/admin/member). The gate is enforced centrally: `is_workspace_member()`
— already the guard on every workspace table — now also requires the caller be
`active`, so a pending account reads no workspace data anywhere. Existing
accounts are grandfathered `active` and the founding account becomes
`super_admin` (no lockout). New signups default to `pending`. **Security fix
found while building this:** the `profiles` self-update policy let a user set
their *own* status/role (self-approve to super_admin) — 0009 revokes table
UPDATE and re-grants only `full_name`, so status/role are service-role only.

- Server-side signup `/api/auth/signup` (service role) enforces `SIGNUPS_OPEN`
  and `SIGNUPS_REQUIRE_APPROVAL`; the signup page is a server gate + client
  form ending on a "what happens next" screen.
- `/admin/approvals` — Approve/Reject/Ban, audit-logged, self + super_admin
  protected. Nav link shows only to admins.
- `/pending` waiting room, outside the `(app)` group so it never loops.

§5.2 **Logout fix.** `requireSession`/`getSession` now send an authenticated
but unapproved account to `/pending`, and an active-but-empty-workspace read to
`/pending?issue=workspace` — **never `/login`**. Only a genuinely absent user
hits `/login`. This is the "empty RLS read looked like a logout" bounce, gone.

§4.2 **Enrolled-row actions** (asked for after Phase 1). The campaign enrolled
table now has per-row **Send now** (pushes one contact's current step out
immediately, reactivating a stalled enrolment first) and **Remove** (out of the
campaign, contact record untouched). Backed by
`/api/campaigns/contacts/actions` + `sendCampaignContactNow`, which reuses the
batch send path so suppression/cap/footer still apply.

**Check live after applying 0009:** you (founding account) are super_admin —
the **Approvals** link appears in the nav; a test signup shows as pending there
and is blocked until you Approve it. On a campaign, each enrolled row has
**Send now** / **Remove**. A normal session no longer bounces to /login.

---

## Phase 1 of the build spec, 28 August (sixth session)

Deployed to `main`. `npm run typecheck` clean, `npm run smoke` **319 passed /
0 failed** (11 new), `npm run build` clean. **Needs migration
`0008_worker_runs.sql`** — apply it by hand in the Supabase SQL editor. The
code survives a deploy landing before it (heartbeat writes no-op, the banner
just does not render); apply 0008 to turn the heartbeat on.

A 12-section "Build & Fix Spec" now drives phased work; Phase 0 audit found the
app already covers ~70% of it. Three gate decisions: **warmup keeps the shared
daily cap** (not a separate budget), **scheduler stays GitHub Actions**
(augment, don't re-platform), **build the multi-user approval gate** (a later
phase). This session shipped Phase 1:

1. **§2 Follow-ups beat first-touch for quota.** `runCampaignBatch` used to
   loop campaigns and order each by `next_send_at` only, so a new campaign's
   step-1s raced week-old follow-ups. It now gathers due contacts across every
   in-window campaign and orders them with the pure `orderByPriority`
   (`src/campaigns/priority.ts`): tier 1 = step ≥ 2, tier 2 = step 1, and
   round-robin across campaigns within a tier so a big new list cannot starve
   the others. Per-campaign resources (steps, mailboxes, config) load once and
   cache. Covered by smoke tests including the spec's 20-follow-ups-then-30-new
   scenario.
2. **§4 "Why isn't this sending?"** `src/campaigns/blockers.ts` — a pure
   `blockerReason()` returning the first reason a contact is not going out
   (suppressed, bad address, campaign paused, no step, no mailbox, scheduled,
   outside window, failed, paused). Shown as a **"Not sending"** column plus an
   **"N not sending"** badge on the campaign page. Reads one extra suppression
   lookup over the page's addresses; everything else comes from data already
   loaded.
3. **§9 Worker heartbeat.** `worker_runs` table (migration 0008) + best-effort
   `recordWorkerRun` in all six cron routes + `readHeartbeat`
   (`src/lib/heartbeat.ts`) driving a red **dashboard banner** when the send
   dispatcher has not run in > 90 min (three missed 30-min ticks). So "nothing
   is sending" can no longer pass unnoticed.

**Where to check live after applying 0008 + this deploy:**
1. **Campaign page** — the enrolled table has a "Not sending" column; stuck
   step-1 contacts show a concrete reason, and the header shows an "N not
   sending" badge.
2. **Dashboard** — no banner while ticks are fresh; the red "send dispatcher
   may have stopped" banner appears if `worker_runs` for `campaigns` goes stale.
   Fire a `campaigns` tick (Actions → Cron tick → Run workflow) to seed the
   first row.
3. **Priority** — with two active campaigns, one with due follow-ups and one
   freshly enrolled, the follow-ups send first. (Pure-logic; verified in tests.)

---

## Four fixes, 27 August (fifth session)

`npm run typecheck`, `npm run smoke` (305 tests, 14 new) and `npm run build` are
all clean. **This session needs a migration: `0007_threads_verification_pause.sql`.**
Apply it by hand in the Supabase SQL editor. The code is written to survive a
deploy that lands *before* the migration (sending never breaks; the new features
just stay dormant until the SQL is applied), but apply 0007 to actually turn them
on.

### 1. Two pitches to the same address now open as separate threads

Conversations were keyed on `(workspace_id, contact_id)` — one thread per
contact ever — so two different website pitches to the same publisher email
collapsed into one inbox thread. They are now keyed on the **email thread**:
`thread_key = coalesce(thread_id, 'contact:'||contact_id)`. Each pitch is its own
outbound thread (its own root Message-ID, carried on replies via In-Reply-To), so
the two split apart, while one back-and-forth exchange still stays together. Mail
with no thread id falls back to the old per-contact grouping. Migration 0007 part
A rewrites the `messages_attach_conversation` trigger and rebuilds existing
conversations (they are derived data, and the workspace had no live reply threads,
so the rebuild is safe).

### 2. An auto-paused mailbox can be revived — and keeps warming up

The health job auto-pauses by setting `health_status = 'paused'`, a field the
Pause/Resume button (which only ever toggled `is_active`) never touched — so an
auto-paused mailbox could not be un-paused from the UI at all, and the only way
back was to remove and re-add it. Fixed on both ends:

- **Manual un-pause.** `PATCH /api/mailboxes` now accepts `health_status`, and a
  **"Resume sending (clear auto-pause)"** button appears on the mailbox card and
  on Deliverability whenever a mailbox is auto-paused. It clears `health_status`
  and `paused_reason`.
- **Auto-paused → warmup only.** On auto-pause the health job now turns warmup on
  and drops its volume to a floor of 5. Outreach stays blocked (loadMailboxes and
  the send reserve both exclude paused), but **warmup keeps running so the mailbox
  recovers**. `mailbox_reserve_send` gained an `allow_paused` argument (migration
  0007 part C); `sendEmail` passes it true only for warmup, and falls back to the
  strict one-arg call if the migration isn't applied yet.
- The warmup on/off toggle and pacing were always reachable regardless of health
  and still are — the manual controls are never locked now.

### 3. Follow-ups keep sending; "agreed" reliably stops them

- **The real bug:** the claim RPC increments `attempts` on *every* claim (not
  every failure) and nothing ever reset it, so after a few steps a contact had
  enough attempts that the next transient hiccup flipped it to `status = 'failed'`
  and it silently dropped out of the follow-up queue forever. The successful-send
  path now resets `attempts = 0`.
- **Marking a deal "agreed" now stops the sequence even from the deals list.** The
  stop only fired when the edit payload carried `contact_id`, which an edit
  usually omits. It now resolves the contact from the saved deal
  (`effectiveContactId`), so agreed/live/rejected stop the follow-ups as intended.
- A genuine reply already stops the sequence (sets `status = 'replied'`); contacts
  who never reply keep getting follow-ups on schedule, which is the default.

### 4. Your own email verifier (Reoon-style, no third-party API)

A full in-house verifier under **Verify** in the nav, plus automatic cleaning of
imported/scraped lists. No external service — nothing leaves your infrastructure.

- **Engine** (`src/validation/verify-engine.ts`) with two modes, exactly like the
  reference tool: **quick** (syntax, disposable, MX, role, free-provider, typo and
  gibberish heuristics — runs anywhere) and **power** (adds a real SMTP
  conversation with the MX to confirm the mailbox exists and detect
  catch-all / full / disabled — `src/validation/smtp-probe.ts`). Statuses match
  the reference taxonomy: safe, valid, role_account, catch_all, disposable,
  invalid, no_mx, invalid_syntax, disabled, inbox_full, spamtrap, unknown — with
  an `overall_score` out of 100 and per-check detail.
- **Auto-clean.** Imported and scraped contacts are quick-checked; anything
  *permanently* undeliverable (bad syntax, genuinely dead domain, disposable,
  spam-trap, disabled account, hard SMTP reject) is **removed from the list and
  added to the suppression list** (per the "Delete + suppress" choice), so it can
  never be emailed or re-imported. Survivors are queued for a deep power check.
  Catch-all and valid remain sendable (per the "send to both" choice). A workspace
  setting `settings.verification.auto_purge` (default on) can turn deletion off.
- **Never deletes on a maybe.** Two deliberate safeguards, both covered by tests:
  a *transient* MX lookup failure (DNS timeout / SERVFAIL) is held as `unknown`
  and retried — it is never confused with a genuine no-MX and never deletes a
  good contact (and failed lookups aren't cached, so one flaky moment can't write
  off a whole domain). And `inbox_full` (over quota today) is *held*, not deleted
  — the recipient is real and may be receiving again tomorrow.
- **The power check needs outbound port 25**, which Vercel and GitHub Actions
  block. It runs from **`scripts/verify-worker.ts`** on a box that allows port 25
  (a small VPS is the reliable choice — many ISPs block 25). Until it runs,
  quick-checked contacts stay sendable; running it further cuts bounces by dropping
  addresses whose mailbox does not exist. The engine treats a blocked/timed-out
  SMTP step as *indeterminate* (keeps the quick verdict) — a blocked host never
  writes off a good address.
- **UI:** `/verify` has a single-address checker (quick/power) with the full
  detail card, and a bulk paste-a-list checker (quick, up to 300) with a summary
  and a "copy the sendable ones" button.

**Correction, same day:** the standalone `/verify` page was removed — verification
belongs *inside* the workflow, not as a separate tool. It now lives on the
**Contacts** page: the score shows as a column, "Verify selected" / "Re-check" /
"Delete" / "Delete and suppress" clean the list, the status filter covers every
new verdict, and imported/scraped contacts are verified (and undeliverable ones
removed) automatically. The `/api/verify/*` routes and the bulk paste tool are
gone; the engine, `verify-worker.ts` and the auto-clean pipeline stay.

Also added: **"Push stuck follow-ups now"** on each campaign (Campaign controls).
It reactivates enrolments stuck on `failed` (unless they replied / bounced /
opted out), clears expired claim locks, makes overdue steps due now, and sends
ignoring the window — for when a scheduled follow-up did not go out on time.
Backed by `POST /api/jobs/run { job:"campaigns", campaignId, release:true }`.

**Where to check live after applying 0007 and deploying:**
1. **Verify** page — paste a mix of good/bad addresses into the list checker; bad
   ones come back invalid/disposable/no_mx, and "copy sendable" copies only the
   good ones.
2. **Import** a small list with an obvious typo/disposable — the result says
   "removed N undeliverable" and they land on Suppressions.
3. **Mailboxes / Deliverability** — an auto-paused mailbox shows a red banner with
   **Resume sending**; clicking it clears the pause. Warmup toggle still works.
4. **Deals** — mark a deal **agreed** from the list; the contact's sequence stops
   (check the campaign's enrolled table shows them completed).
5. **Power worker** — run `npx tsx scripts/verify-worker.ts` on a port-25 box with
   `NEXT_PUBLIC_SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` set; it reports
   "checked N, removed M".

---

## Three fixes, 21 August (fourth session)

Reported after the tracking work went in. All three are done; `npm run typecheck`,
`npm run smoke` (291 tests, 9 new) and `npm run build` are clean. **No migration**
— reports reads the same `messages.meta` tracking the contact and campaign pages
already read. Not yet verified against live data (no `.env.local` in this
checkout).

### 1. Opens and clicks on Reports

Tracking showed on the contact and campaign pages but never on Reports. New
**"Opens & clicks"** section on `/reports`, between the volume chart and the
funnel: emails opened (and the open rate), total opens, emails clicked (and the
click rate), total clicks, and **how many of the sent emails were tracked for
clicks** — the "how many emails sent with clicks tracked" that was asked for.

`summariseEngagement` in `mail/tracking-summary.ts` does the roll-up, fed the
`meta` the reports query already selected — so it costs no extra query and can
never disagree with the sent count on the same page. **Rates are out of
*tracked* emails, not every email sent**: an email sent with tracking off can
never register an open, and counting it against the rate would drag the number
down for a reason that has nothing to do with the recipient. Warmup and any mail
sent before tracking existed carry no `meta.tracking`, so they fall out of the
denominator on their own. The section says "No tracked emails sent in this
period" rather than showing zeroes when there is nothing tracked — "we do not
know" must never render as "they did not".

### 2. Paste both columns at once, separate in one click

The two-box importer meant pasting the website column and the email column
separately. But copying two adjacent columns out of Google Sheets gives **one**
block (tab-separated rows), not two. New default **"Paste both columns
together"** mode on the import form: paste the one block, click **Separate into
website + email**, and each half drops into its own box lined up row by row, to
check before importing.

`separateCombined` in `lib/import-parse.ts` is the split. It handles the
row-per-line shape (`site<tab>email`, either order, tab/comma/space) and the
stacked shape (all sites then all emails). Blank halves are kept in the
row-per-line case so a row missing one side stays lined up — the same reason
`pairColumns` preserves mid-column blanks. It only decides which side each token
belongs on; `pairColumns` still re-parses and validates, so nothing new can slip
past the existing checks. The two-box and one-per-line modes are still one click
away.

### 3. Renaming a campaign from the list

Renaming already worked on the campaign's own page ("Manage campaign"), but the
list — where you see all the names together and notice one is wrong — only
linked through to it. `CampaignNameCell` puts an inline **Rename** on the name
itself in `/campaigns`, hitting the same `PATCH /api/campaigns` the detail page
uses. Enter saves, Escape cancels.

---

Live at **https://crm.orankly.com**. Everything here is on `main` and deployed.
Pushing `main` deploys straight to production, so ask before pushing.

**The 20 and 21 August work below is committed but NOT yet deployed and NOT yet
verified against live data.** Start with "What to check live" at the end of the
21 August section, then "Six fixes, 20 August".

---

## Six fixes, 21 August (third session)

Reported after another few days of use. All six are done; `npm run typecheck`,
`npm run smoke` (282 tests) and `npm run build` are clean. **No migration is
needed for any of it** — see "Why tracking lives on messages.meta" below.

As with the last session, nothing here has run against the real Supabase or a
real mailbox: there is no `.env.local` in this checkout. After deploying, the
things to actually look at are listed under "What to check live" at the end.

### 1. Clearing the suppression list, not deleting it row by row

Last session added delete buttons. The ask was to *empty* the list — the storage
is the point, not the individual rows.

`DELETE /api/suppressions?all=1` is a separate path from the id-list delete, and
deliberately so: the page only holds the newest 1,000 entries, so "delete
everything on screen" would have left the rest behind and reported success. The
scope is the same reason filter and the same search box the reader can see, the
count is taken **before** the delete (a delete cannot report how many rows it
removed once they are gone), bounces and complaints still need `confirm=1`, and
the removal is written to the activity log as `suppression.cleared`.

The button reads "Clear the list (1,234)" with no filter set and "Clear filtered"
with one, so it always says what it is about to do.

### 2. Reading their email inside Edit deal

The screenshot that came with the report says it: **Edit deal** offered "Read
pasted text" and "Load starred emails" and nothing else, so checking a quoted
niche price meant leaving the form for the inbox and losing whatever had been
typed.

New `GET /api/messages/thread`, addressed by `contact_id`, `conversation_id` or
`domain` — a deal has at least one of the three, and a hand-entered deal has only
the domain. The domain lookup matches the deal's domain against both the
contact's domain *and* its address, because a publisher answers from whatever
address they like.

In the form it is a panel inside "Fill from their email": every message with
sender, date and subject, expandable to the full text in a scrollable block, with
**Use this** running the existing quote parser on it and **Copy into the box
below** for the paste field. It loads when the editor opens rather than on a
click — being already there was the request. Three details worth keeping:

- **Inbound only gets "Use this".** Parsing our own email back would fill the
  rate card with the numbers we quoted them.
- **Skipped in the inbox** (`compact`), where the message is on screen anyway.
- **A brand-new deal gets a button instead**, because the domain is being typed
  a character at a time and a fetch per keystroke is what a button is for.

The modal went from `max-w-3xl` to `max-w-4xl` to give it room.

### 3. Sent today, split into warmup and real outreach

The mailboxes page had 7 / 14 / 30 day volume and a "Sent today" bar that was
one number. **Today** is now the first option on the same toggle, and the page
opens on it.

"Today" is the **UTC calendar day**, not a rolling 24 hours, because
`sent_today_date` — the counter that resets the daily limit — is written as
`toISOString().slice(0, 10)` everywhere in this app. A rolling window would
disagree with the "Sent today" bar on the same card every evening, and this is
the figure that would look wrong.

The today view shows the split and no daily average: "0.4 a day" for a day that
is still happening says nothing, and how much of today's allowance went on warmup
rather than on prospects is the whole reason to look at one day.

### 4. Open and click tracking

**`meta.tracking` on the message row**, written by two new public endpoints:

- `GET /api/track/open?m=&s=` — a 1×1 GIF, `no-store`, returned whatever happens
  to the write. A broken image in a prospect's inbox is worse than a missed count.
- `GET /api/track/click?m=&u=&s=` — records, then 302s to the destination.

Both are unauthenticated, because the caller is the recipient's mail client. The
HMAC is what authorises the write, and the click signature covers **the
destination as well as the message id** — an unsigned `?u=` here would be an open
redirect on crm.orankly.com, which is worth more to a phisher than the tracking
is worth to us. Non-http(s) targets are refused, and a bad signature redirects to
the home page rather than following the URL it was handed.

What is recorded per message: open count, first open, last open, click count,
first/last click, and a count per link. **The first open is never overwritten** —
"has he opened it" was the question. A click also implies an open, because images
off and a link clicked is ordinary, and "clicked but never opened" reads as a bug.

Where it shows:

- **Contact page** — a line per outbound message ("Step 2 · Opened 3× · first 21
  Aug 14:22 · 1 click"), plus a roll-up in the card header. Per message, and per
  step, is exactly the "did he open the follow-up" question.
- **Campaign page** — "Opens and clicks by step" (openers as a percentage of
  sent, with the raw open count when it is higher), and an **Opened** column on
  the enrolled table. Both come from one `messages` read, so they cannot disagree.
- **Settings** — off / opens only / opens and clicks, default opens and clicks.

Three things deliberately not tracked: **warmup** (peer mail between your own
mailboxes — nothing to measure, and a remote image in traffic meant to look like
correspondence), **the connection test** (your own open), and **the closing
block**. Link rewriting runs on the message body only, before the signature and
the CAN-SPAM footer are appended, so the one-click unsubscribe link stays exactly
what `List-Unsubscribe` promises and our own footer is never scored as engagement.

The message id had to be **minted before the send** (`crypto.randomUUID()`, then
inserted explicitly) because the pixel and every rewritten link carry it, and
they go into an email that leaves before the row exists.

The mode is stored **on the message** as well as read from the workspace, so
turning tracking off later does not make every email ever sent read as "never
opened" instead of "not tracked". Those two must never render the same way: one
is "we do not know", the other is "they did not".

The Settings copy says the two honest caveats out loud: images blocked means no
open recorded, Apple Mail's privacy proxy fetches images before anyone reads
anything, and a rewritten link points at crm.orankly.com rather than at the site,
which some filters weigh against cold mail. **Opens only** keeps the signal and
leaves links alone.

#### Why tracking lives on `messages.meta`

Every migration in this project is applied by hand in the Supabase SQL editor. A
feature that needs one is dark between deploying and remembering to run it, and a
half-applied schema breaks reads on pages that have nothing to do with the
feature. `meta` is jsonb that already exists on every row and is already selected
by the pages that show this. The cost is that two opens in the same instant can
lose a count to a read-modify-write race — a duplicated open of one email is not
a number anyone acts on. If this ever needs to be exact, the upgrade is a
`message_events` table plus an atomic increment, and `mail/tracking-summary.ts`
is the only module that would change.

### 5. "facebook.com,info@facebook.com" pasted as one cell

Both halves on one line already worked in the *one-per-line* box. In the
**two-box** mode — which is the default — it silently lost the address, and the
reason is worth writing down: `new URL()` reads everything before an `@` as
userinfo, so `facebook.com,info@facebook.com` parses as a perfectly valid URL
with host `facebook.com` and the address swallowed into the credentials. It
imported as a website and the email disappeared without a word.

`pairColumns` now pools both cells of a row into one set of tokens and picks the
address and the website out of them, so a row survives whichever way round it was
pasted: two clean columns, a combined cell in either box, or a website sitting in
the email column (which is no longer reported as a broken address). The test for
"is this a website" is now **no `@`** first, URL-shaped second — that guard is the
whole fix, and it is shared with the one-per-line parser.

### 6. A new campaign taking contacts another campaign is already using

Reported as: added contacts to a new campaign, got 100 that were already in the
other one.

**The check that existed asked the wrong question.** `enrollContacts` looked for
"is this contact already in *this* campaign" — nothing anywhere looked outside the
campaign being added to. And the filtered "add matching contacts" query simply
took the newest N validated contacts, so the 56 already enrolled were the first
ones it found.

Both halves fixed, in `campaigns/exclusions.ts`:

- **Any row in `campaign_contacts` counts as used**, whatever its status —
  pending, mid-sequence, completed, bounced, opted out. All of them mean the
  person has been written to.
- **The campaign is named**, in the API response, in the form's message and in
  the activity log: "Added 12, 44 already in First Campaign (44)".
- **"Max to add" means 100 *new* contacts.** The selection pages through
  candidates (1,000 at a time, up to 20,000 scanned) filtering against the
  used set until it has enough, and says so when it stops early — stopping at
  the first 100 rows would have found none and reported nothing wrong.
- **An explicit override**, off by default: "Allow contacts already in other
  campaigns", for deliberately re-contacting from a second angle.

Shipped alongside, because this path can now hand five thousand ids to a query:
`loadEnrolments`, the contacts read in `enrollContacts` and `suppressedSubset` all
**chunk at 200 ids**. `in` goes into the query string, and five thousand uuids is a
180KB URL the gateway rejects before Postgres ever sees it.

### What to check live

In order, after deploying:

1. **Settings** — the tracking dropdown reads "Opens and clicks" (the default).
   Turn it to "Opens only" if the rewritten links are a worry on cold mail.
2. **Mailboxes** — the toggle opens on **Today** and the cards say how much of
   today's allowance went on warmup.
3. **Suppressions** — "Clear the list (n)" reports the same n it deletes.
4. **Deals → Edit** on a publisher who has replied — their emails load in the
   form. This is the one that needs real data to prove anything.
5. **Campaigns → First Campaign → Add contacts** with the box ticked at 100.
   It should add nothing and say "already in First Campaign (n)" — that is the
   bug being fixed, reported correctly.
6. **Tracking end to end** needs a real send: press **Run campaign now**, open
   the email in Gmail, and the contact page should say "Opened once". Until an
   email is actually sent *after* this deploy, every existing message will read
   "not tracked" — correctly, because it was.

---

## Six fixes, 20 August (second session)

Six things the user reported after a few more days of use. All six are done;
`npm run typecheck`, `npm run smoke` (257 tests) and `npm run build` are clean.
**None of it has been exercised against a real mailbox** — there is no
`.env.local` in this checkout, so nothing here has run against Supabase or
Gmail. Per the verification habits at the bottom of this file, that means the
first thing to do after deploying is press **Poll mailboxes now** and read what
it says.

### 1. "Checked 5 of 5" when seven mailboxes are connected

**The button was reporting its own cap back as the total.**
`<RunJobButton job="inbound" limit={5} />` on the mailboxes page asked the
server for five mailboxes, got five, and rendered "Checked 5 of 5" from
`polled + deferred`. There was no number anywhere in the response that knew the
workspace had seven. The inbox's two buttons had the same shape with `limit={20}`.

Fixed at every level rather than by raising the cap:

- **No limit at all** on any of the three buttons. `limit` is now optional
  through `runInboundPoll`, and omitted means every mailbox that qualifies.
- **`queued`** is returned alongside `polled`/`deferred` — the size of the queue
  before any budget was applied — and the message is built from it.
- **`unpollable`** names connected mailboxes that could not be queued *at all*,
  with the reason. A mailbox with no stored credentials is invisible to the
  poll query, so without this the same "n of n" lie was still possible.
- **Paused mailboxes are polled**, by the cron as well. Pausing stops a mailbox
  *sending*; the replies to what it already sent still arrive, and dropping them
  because of a toggle that means something else loses real mail.
- **The button keeps asking** until `deferred` is 0, up to 8 rounds, showing
  "Checked 4 so far, 3 to go…" in between. One request can only do what fits in
  60 seconds; pressing the button repeatedly was the user's job before.

### 2. IMAP timeouts, "Connection not available", "socket timeout"

Three separate causes, all fixed:

**A poll downloaded every message in full before deciding what it was.** The
fetch asked for `source: true` over everything above the checkpoint. On a
personal Gmail account that is newsletters, receipts and notifications — none of
which this app ever stores — pulled down in full, one `simpleParser` each. That
is the 25 seconds.

Polls are now **two phases down one connection**
(`fetchInboundSelective` in `mail/providers/smtp.ts`): envelopes plus nine
headers for everything unseen, a decision, then full sources for *only* what is
going to be stored. `mail/prefilter.ts` holds the decision and is pure, so it is
covered by tests. It is deliberately no stricter than the storing path behind
it — it keeps anything that threads back to our outbound mail, not just mail
from an address we wrote to, because publishers answer from a different address
all the time.

Warmup mail is now handled **from the envelope**, with nothing downloaded: every
field the counter reads is in the header.

**An abandoned poll never hung up.** `pollWithTimeout` raced the poll against a
25-second timer and walked away from the loser — but the IMAP socket carried on,
still counting against Gmail's per-account connection limit until the server
reaped it. The next mailbox asking for a connection is the one that got
"Connection not available". `pollMailbox` now takes an `AbortSignal`, the
provider tracks its live clients, and `close()` tears them down mid-flight.

**`socketTimeout` was above the caller's ceiling.** 30s inside a 25s race, so a
stalled socket could never surface as a named error — the stopwatch always won
and every failure read as "Timed out after 25s". Now 18s, under the ceiling, so
the real cause has a chance to be reported. Plus **one retry** on transient
failures only (`isTransient`), because "Connection not available" is usually
gone a second later, while a wrong app password is not.

### 3. Warmup conversations

`warmup/content.ts` was 15 subjects, 6 openers, 7 middles, 5 closers and 7
replies drawn from **separate global pools** — so a body was three grammatical
sentences about nothing in particular, and a reply had no relationship to the
message it answered.

It is now **24 topics**. A topic is a small work situation (a draft going round,
a supplier quote, cover for next week) with its own subjects, openers, bodies,
closers, and **three turns of replies written for the turn they appear in**. A
thread stays on one topic start to finish.

- **3.6 million distinct opening messages** (`corpusSize()`, asserted in the
  tests, so trimming the corpus fails a test rather than passing quietly). At
  seven mailboxes and five a day that is ~12,800 sends a year.
- **288 written reply lines**, plus 288 more combinations with the shared tails.
- **A thread is deterministic in its own root message id**, seeded per depth, so
  the same conversation always produces the same next line however many ticks it
  takes to play out — and provably never repeats itself within a thread.
- The topic is recovered from the **subject line**, "Re: " prefixes stripped, so
  none of this needed a migration.
- **Half of threads now become conversations**, up from one in four
  (`CONVERSATION_IN_EVERY`), of two or three replies. That trades new threads for
  deeper ones rather than adding volume — every turn spends the same daily cap.
  Three replies is the ceiling because three turns is what is written; a longer
  thread would have to reuse a turn.

### 3b. Warmup now ends with the same closing block as real outreach

Reported from a screenshot: the test email closed with the postal address, the
four icons and the opt-out, while warmup mail closed with a bare
`Best Regards, Team Orankly / Address / Phone` and no icons.

**Cause.** Warmup passed `includeFooter: false`, so `postal` stayed null, so
`signatureCarriesAddress` had nothing to compare against and `mailboxes.signature`
— which holds that address text — printed as an ordinary sign-off instead.

**The earlier reasoning was wrong and has been reversed.** Warmup was excluded
because peer mail fetching four remote images every time was "pointless and a
distinctive fingerprint". But leaving the block off did not make warmup look like
nothing; it made it look like a *different sender* from the one being warmed up.
The account then had two shapes of outbound mail and only one of them was the
shape real outreach goes out in. `includeFooter` now defaults to **true for every
kind**, and the two `includeFooter: false` lines in `warmup/engine.ts` are gone.

Three things had to move with it:

- **The corpus no longer generates its own sign-off.** A warmup body ending
  "Speak soon," directly above "Best Regards, Team Orankly…" is two sign-offs —
  exactly the two-signature shape the footer rebuild existed to remove. Bodies
  now end on their last sentence and the closing block closes the email, as an
  outreach email does. The opening pool drops from 3.6M to 604,800, which is
  still ~47 years of sending before a repeat is likely.
- **`canSend` requires a postal address for every kind**, not just campaigns.
  Otherwise a warmup send passed the guard, reserved a slot against the daily
  limit, then failed inside `sendEmail` with nothing to print — the slot is
  released, but the reason never reaches the batch's `skipped` list, so the run
  reports a mailbox that simply did nothing.
- **Your own mailbox can never be suppressed.** This is the hazard the change
  introduces and the part to keep. Warmup mail now carries an opt-out link and
  `List-Unsubscribe` headers addressed to *one of your own mailboxes*. Gmail
  prefetches and scans links, offers its own one-click unsubscribe from that
  header, and a person may simply click it to see what it does. Any of those
  would put a sending address on the suppression list, and `canSend` would then
  refuse every warmup message to it — silently, because a skipped send looks
  identical to a rested mailbox. The guard is in `suppressEmail`, the single
  choke point every suppression path goes through, not in the unsubscribe route
  alone; refusals are logged as `suppression.refused_own_mailbox`, and the
  unsubscribe page says what happened instead of claiming success.

Both a warmup opening and a warmup reply were rendered through the send path's
own functions and read end to end: one closing block, address once, four icons,
one "Unsubscribe".

### 4. Deleting suppressions

Hard bounces and complaints rendered as the word "locked" with no route past it.
One guard too many: a bounce classified from wording rather than an SMTP status
code can be wrong, and a wrongly written-off address had no way back.

Everything is deletable now, but never by accident — a second, differently
worded confirmation for the protected reasons, `confirm=1` required on the API,
and every removal written to the activity log with its reason. Alongside it:
**search** by address or source, a **reason filter**, **select-all and bulk
delete**, and a footer that says what deleting actually means. Selection is
intersected with what is on screen, so filtering after selecting cannot delete
something the reader can no longer see.

### 5. Daily / weekly / monthly volume on Reports

Grouping was welded to the period: over 92 days you got weeks, under it you got
days, and there was no way to ask for anything else. So twelve monthly totals —
the obvious thing to want from a twelve-month report — could not be had.

**Volume** is now its own dropdown next to **Period**, in the URL as `bucket`.
Monthly bars follow the **calendar**, not 30-day blocks: a month means something
that a rolling 30 days does not, and the tooltip reads "August 2026" rather than
a date range. First and last buckets are genuinely partial and `days` says so.
An explicit choice always wins, including daily bars over a year — an unreadable
chart, but a control that quietly ignores you is worse. The chart header now
carries the total and the per-bucket average, averaged over buckets that
actually had sending in them.

### 6. Deals: search by domain, and which address closed it

The domain box was already there but read as one filter among six; it is now a
wide **Search domain** field with a placeholder saying partial matches work.

The new part is **Closed on**: a column, and a filter. Which of the seven
addresses won a publisher was never recorded on `deals` — but the conversation
the deal was logged from knows (`conversations.mailbox_id`), and a hand-entered
deal with no conversation falls back to the last message exchanged with that
contact. Resolved once per page load and used for both the column and the
filter, so they cannot disagree. No migration. It is in the **xlsx/csv/tsv
export** as a "Closed on" column and in the **read-only API** as
`mailbox_email`, since "which of our addresses agreed this" is the first thing
anyone asks of that spreadsheet.

---

## Where the campaign actually stands

- **First Campaign** — `active`, 56 contacts enrolled, 5 emails sent so far.
- Schedule: **01:00–24:00, Tuesday–Friday, Asia/Karachi**.
- Monday is deliberately unticked. The user plans to tick it at the weekend.
- On 17 Aug (a Monday) a real tick correctly returned
  `notes: ["First Campaign: outside sending window"]`. Nothing was broken —
  Monday was switched off. First automated send is **1 AM Tuesday 18 August**.
- 7 Gmail mailboxes connected via app passwords. Daily limit 5 each, gap
  90–120 min. Warmup shares that same daily budget.

### Cron is confirmed working (17 Aug)

`CRON_SECRET` is set as a repository secret and **Cron tick #1 ran on schedule
and succeeded**. That green tick means something: the workflow exits 1 unless
every endpoint returns exactly 200, so a wrong secret would have failed it. The
log read:

```
validate / scrape / health / campaigns / warmup / inbound -> HTTP 200
campaigns notes: ["First Campaign: outside sending window"]   # Monday, correct
All jobs returned 200.
```

The secrets page itself never shows a status colour — the green lives under
Actions → Cron tick.

**The tick is now every 30 minutes, not every 10.** This repo is private, so runs
bill against the 2,000 free minutes a month and GitHub rounds every run up to a
whole minute. `*/10` is 144 runs a day ≈ 4,300 minutes a month — the allowance
would have gone in about a fortnight, and when it goes sending stops without
saying so. `*/30` is 48 runs a day ≈ 1,450 a month and costs almost nothing in
throughput, because each mailbox rests 120–240 minutes between sends anyway.
If a tick ever needs to run sooner, Actions → Cron tick → "Run workflow" fires
it by hand.

### Still to confirm

1. **Warmup target is 5/day on every mailbox**, so all four originally checked
   read "5 → 5, fully warmed". 5/day is not a warmup. The schema default is 40.
   Raise it in Deliverability. Until then `sendingAllowance` sees "warmed" and
   hands straight back to the daily limit, protecting nothing.

---

## Pending work

Both items below were **built on 17 August** and are committed on `main`.
Nothing else is outstanding from the previous list.

1. ~~Mailbox sent-volume views: 7 / 14 / 30 days.~~ Done — see below.
2. ~~Duplicate campaign.~~ Done — see below.

Both were verified on **crm.orankly.com** after deploying, not just in tests:

- Volume figures render per mailbox against real data, and the toggle moves all
  seven cards together. Most mailboxes read "5 in 7 days — 4 of those warmup,
  1 real outreach", which matches a workspace that has only been sending since
  17 August. 7-, 14- and 30-day counts are identical for now because nothing is
  older than a week; the per-day average is what changes (0.7 → 0.2).
  **The first cut showed "1 outreach · 4 warmup" side by side and the user
  corrected it**: warmup spends the daily limit, it does not sit on top of it. A
  mailbox set to 6 a day sends six emails in total. The total is the headline
  now, with warmup named as a share of it.
- Duplicating **First Campaign** produced "First Campaign (copy)": draft, all 7
  sequence steps, all 7 mailboxes, 01:00–24:00 Tue–Fri Asia/Karachi, and
  **0 contacts**. The source was untouched — still active with 56 contacts.

That draft copy is still there. Delete it whenever; it was the test.

---

## Scheduling: how it works now, and why

Vercel Hobby allows one cron a day. That is not just slow, it **caps
throughput**: a mailbox must rest ~2 hours after a send, so one tick sends at
most one email per mailbox. One tick a day = ~7 emails a day regardless of
configured limits. That is exactly what "Sent 5, skipped 51" was.

`.github/workflows/tick.yml` runs **every 10 minutes** and calls the six
per-job endpoints **in parallel**:

```
/api/cron/campaigns  warmup  inbound  health  validate  scrape
```

Not `/api/cron/tick`. Serial ticking spent its whole 60s budget on IMAP and
deferred everything else on virtually every run. Parallel calls give each job
its own invocation and its own 60s.

`/api/cron/tick` still exists and works to a 45s budget, deferring what will not
fit. Kept as a single-call fallback.

Vercel's own daily cron fires at `0 7 * * *` (noon Pakistan), inside the window.

### The 60-second wall — three separate timeouts, all fixed

Warmup threading pushed things over the limit and everything cascaded:

| Job | Cause | Fix |
| --- | --- | --- |
| `tick` | all 7 jobs unconditionally | 45s budget, defers and reports |
| `inbound` | ~25s per mailbox, default 3 | default 1, budget check before a second |
| `warmup` | IMAP engagement, default 3 mailboxes | default 1, own 40s budget |

A 504 is worse than slow: the response never returns, so work already committed
goes unreported and the Actions run fails.

**If a timeout returns, lower a batch limit — do not raise `maxDuration`.**
Hobby caps at 60s.

---

## Bugs found and fixed this session

Roughly in order of severity.

**Several emails from one mailbox in a batch.** User saw 5 leave
`webwarner.com@gmail.com` at once. `loadMailboxes` reads the pool once per run
and nothing wrote sends back, so `sent_today` and `last_send_at` stayed frozen —
the mailbox that just sent still looked rested and unused, and `pickMailbox`
chose it again. `recordSend()` now updates the in-memory pool. One email per
account per batch; 8 accounts → 8 at once.

**Connecting a mailbox failed: "permission denied for table mailboxes".**
Migration 0002 revokes table-level SELECT and re-grants column by column,
omitting `encrypted_credentials`. The connect route upserted through the
request-scoped client and asked for the row back; PostgREST read the revoked
column to build the response. Credentials were fine — only the read-back died.
Uses the admin client now, as `/api/mailboxes/test` already did. **PATCH and
DELETE stay on the request-scoped client** — they do not read back, and they
keep RLS as a second line of defence.

**A paused mailbox stranded its follow-ups forever.** `loadMailboxes` filters
out health-paused mailboxes, so an assigned contact matched nothing and was
skipped silently every tick. Absent-from-pool now fails over to a healthy
mailbox and records the switch; subject and threading survive because they come
from the first message. A mailbox merely *resting* is still waited for —
switching sender to save hours is not worth breaking a conversation.

**Closing a deal did not stop the emails.** The pipeline was pure bookkeeping.
`stopOutreachForContact` is now the single path: won/lost stage moves and
agreed/live/rejected deals end queued follow-ups. Lost and rejected also
suppress.

**Editing the schedule did not move enrolled contacts.** Each enrolment stores
its own `next_send_at`. Changing the window left 51 contacts on "next Monday
01:00" — screen showed one schedule, contacts followed another. Saving settings
now recomputes for `current_step = 0` only; mid-sequence contacts keep their
delay.

**Every Gmail mailbox read as DKIM-missing.** The check probes common selectors;
Google signs with rotating dated selectors that cannot be guessed. All mailboxes
sat at "warning" permanently — a health system whose light is always on cannot
warn. `PROVIDER_MANAGED_DOMAINS` in `health/dns.ts` reports their auth as the
provider's.

**Validation was one-way.** Only `unknown` rows were selected *and* the write was
guarded the same way, so a DNS timeout wrote a contact off as `no_mx` forever.
`force` skips both guards. Suppressed is still never re-checked into sendable.

**Inverted sending window sent at hours nobody chose.** Campaign was set 13 → 12;
`resolveWindow` silently substitutes 09:00–17:00. Now flagged and Save disabled.

**Timezone displayed one value and saved another.** Empty stored value, select
fell back to detected for display only. Now commits the fallback.

**`vercel.json` had an hourly cron.** Hobby rejects anything more frequent than
daily, failing the whole deployment. This is why the very first deploy never
happened.

---

## The inbox showed sent mail (fixed 17 August)

The user opened the inbox and found the five campaign sends sitting there as
conversations. Sent mail must never appear — the inbox is a reply hub.

**Cause.** `messages_attach_conversation` (migration 0005) creates a conversation
row on the *first message of any direction*, outbound included. So every contact
emailed became a conversation, and the inbox listed conversations.

**Fix.** The inbox resolves the set of conversations that carry at least one
inbound message and lists only those. Filtering on `last_direction = 'inbound'`
would have been wrong in the other direction: replying would make a real thread
disappear. The trigger was left alone — those rows still drive the contact
timeline and the pipeline's "last touch".

Shipped with it, from the same report:

- **Which mailbox holds the thread** is shown in the list and in the header.
- **Reply from a different mailbox** — a dropdown on the reply box, warning that
  the recipient will see an address they have not seen before.
- **Unread count** is now taken across every replied thread, not just the rows
  the current tab shows.
- **"Close" is now "Mark done"**, with a line explaining it: hides the thread
  from Open, deletes nothing, and a new reply brings it back automatically.
- **Logging a deal stars the thread in Gmail.** Gmail's star is the IMAP
  `\Flagged` flag, so `flagByMessageId` on the provider does it with no API and
  no new scope. The *received* message is flagged — starring our own copy would
  mark it in Sent, where nobody looks — searched by Message-ID in INBOX and in
  the `\All` folder, since the thread may already be archived. Best-effort with
  a 15s ceiling, and the form says whether the star actually happened.
  `src/mail/star.ts` uses the **admin client**: `encrypted_credentials` is
  revoked from the authenticated role.

**Verified:** the sent-only threads are gone from the live inbox, which now reads
"Nothing waiting". **Not yet verified:** the mailbox picker, "Mark done", and the
Gmail star have no replied thread to exercise them on — the last tick reported
`replies: 0`. Check them the first time a publisher writes back.

## Features added 20 August

Six things the user asked for after living with the app for three days. All of
them are UI-reachable; nothing here needed a migration.

- **Orankly's social icons in the email footer**
  (`src/mail/signature.ts`, `mailbox-signature.tsx`, `public/signature/*.png`).
  They render in the closing block with the postal address — see "Where the icons
  go" below, which is the part to read before touching any of this. The editor is
  on each mailbox card, with **Save to every mailbox** for the normal case — one
  company, seven addresses. It also finally exposes `mailboxes.signature`, which
  had existed since migration 0002 with **no screen ever setting it**.

  The icon row is WhatsApp → LinkedIn → Facebook → Instagram, the same four
  links and the same order as the footer of orankly.com
  (`wa.me/12819694177`, `/company/orankly`, `webwarner`, `webwarnerofficial`).
  They are **constants, not settings**: a URL field per network per mailbox would
  be twenty-eight chances to typo four links.

  Three decisions worth keeping:
  - **Hosted PNGs, not inline SVG.** Gmail, Outlook and Yahoo strip `<svg>` from
    a message body, and Gmail's image proxy refuses an `.svg` in `<img>`. The
    marks are rasterised from the website's own paths by
    `npm run signature-icons` and committed, so a deploy never runs sharp.
  - **A table, not flex.** Outlook's Word renderer ignores the layout CSS but has
    always laid out tables. Every `<img>` carries explicit width/height and real
    alt text, so images-off shows the network names.
  - **Warmup gets neither the footer nor the icons.** Peer mail between your own
    mailboxes fetching four remote images every time is pointless and a
    distinctive fingerprint.

  Which icons appear is stored on `mailboxes.meta.socials`. An **absent** key
  means all four (the request was that mail carries them; defaulting to none
  would mean seven mailboxes to visit before anything changed); an **empty
  array** means somebody switched them off, and is respected.

- **Edit and delete a deal** (`deal-row-actions.tsx`, Actions column on
  `/deals`). No new endpoint: `POST /api/deals` with an `id` already updated in
  place — the inbox uses it when a publisher revises a quote — there was simply
  no way to reach it from the page the deals are on. The editor opens in an
  overlay rather than expanding the row, because a rate card is a thirty-field
  form and the table already scrolls sideways. `DELETE` now reads the domain
  before removing the row so the activity log says *which* publisher went
  (`deal.deleted`); `deal_prices` cascades with it.

- **Enrolled contacts paginate** (`/campaigns/[id]?page=`). It was a bare
  `.limit(100)` with nothing to click, so a 400-contact campaign silently showed
  a quarter of itself. 50 a page, `count: "exact"` on the same query so "of 56"
  comes from the table rather than from the `campaign_stats` view, which lags a
  just-finished enrolment. **A second `.order("id")` is load-bearing:** hundreds
  of rows share the same `next_send_at` (or share null), and Postgres may return
  equal rows in any order — without a tiebreak the same contact appears on two
  pages while another never appears at all.

- **Reports cover a window you choose** (`src/reports/ranges.ts`,
  `report-range-picker.tsx`). 7 / 14 / 30 days, 3 / 6 / 12 months, and year to
  date. The range lives in the **URL**, so the numbers are fetched server-side
  for the window asked for — a client-side filter would ship a year of rows to
  show a week of them — and a view stays linkable across a refresh.
  `since` is **midnight UTC** on the first day, not "now minus N × 24h": the
  chart buckets by UTC calendar day, so a mid-afternoon cutoff gave the earliest
  bar part of its traffic and made it look like a quiet day.

- **The volume chart folds into weeks past ~13 weeks** (`buildSeries` in
  `reports/metrics.ts`). 365 daily bars in a card a few hundred pixels wide are
  each sub-pixel and read as a solid block. Weeks are aligned to the **end** of
  the range, not to Mondays — the rightmost bucket must end today, or the last
  bar is a partial week that looks like sending collapsed.

- **Reports' mailbox table has its own windows: 7 / 14 / 30 days, 2 and 3
  months** (`report-mailbox-table.tsx`). Independent of the page range on
  purpose — picking "7 days" at the top must not empty the "3 months" column
  underneath. `summariseVolume` took the windows as a parameter for this rather
  than being copied, so "does 30 days include a send from exactly 30 days ago"
  has one answer. The rows are read back over whichever is wider, the page range
  or 90 days. Health, score and bounce rate stay **current, not windowed** —
  they describe the mailbox now.

- **The pipeline board is its own scroll region** (`pipeline-board.tsx`). With a
  tall column the page used to scroll away from the stage headings, so once you
  were far enough down and far enough right nothing on screen said which column
  you were in — "I can't see Agreed". Bounding the board's height lets the
  headings be `sticky` and keeps the horizontal scrollbar reachable. Four ways to
  reach a far column now: **← →** buttons that step one column, **stage chips**
  above the board that scroll a named stage to the left edge, the board
  **scrolling itself** when a drag is held near an edge, and the per-card
  dropdown on touch. The explainer card is collapsed to a `<details>` — it is
  read once and it was taking a third of the screen the columns needed.

  Two details: the edge auto-scroll is an **interval**, not a reaction to
  `dragover`, because `dragover` stops firing when the pointer holds still,
  which is exactly what somebody does while waiting for the board to come to
  them. And the stage chips do not use `scrollIntoView` — that walks up every
  ancestor and would scroll the page too, which is the jumping-about the layout
  exists to stop.

**Where the icons go — got this wrong twice, so it is worth being explicit.**

The email must end with **one** closing block, and it is the CAN-SPAM footer:

```
—
<sending postal address, from Settings>
[WhatsApp] [LinkedIn] [Facebook] [Instagram]
Unsubscribe — you will not be contacted again.
```

The first cut hung the icon row under `mailboxes.signature` instead. That put a
dark sign-off with icons directly beneath the body, and then the grey address
block with the unsubscribe line underneath it — **two signatures on every
email**, and the user rejected it twice. The second cut only stopped the address
repeating, which was still the icons in the wrong place.

So: `renderSocialRowHtml` / `renderSocialRowText` are called from
`buildFooterHtml` / `buildFooterText`, not from `buildSignature`. `buildSignature`
now renders the sign-off text and nothing else.

`mailboxes.signature` survives as an **optional personal line** ("Best, Haseeb")
above that block, and should normally be empty — the footer already carries the
company name, both offices and both phone numbers. When the signature only
repeats the postal address, `signatureCarriesAddress` suppresses it and the
footer alone closes the email. That comparison is normalised (everything that is
not a letter or a digit collapses to one space, lowercased) because the same
address is never typed the same way twice, and it lives in `mail/signature.ts`
rather than `mail/unsubscribe.ts` **so the mailbox editor can import it** —
`unsubscribe.ts` pulls in `node:crypto` for the HMAC and cannot cross into a
client component.

It is conservative in a direction that cannot hurt: unsure means false, and false
only ever means "print the sign-off as well". The footer prints the address
either way, so a wrong guess can never lose the address the law requires. The
address is still *required* — `canSend` refuses to send without one.

The editor on each mailbox card renders that exact block as a live preview,
sharing `signatureCarriesAddress` with the send path, so what it says about a
sign-off being skipped is what will actually happen. It needs
`workspaces.sending_postal_address` passed in from the page for that.

Warmup passes `includeFooter: false`, so it gets no footer, no icons and no
opt-out — peer mail between your own mailboxes fetching four remote images every
time would be pointless and a distinctive fingerprint.

**Verification:** `npm run typecheck`, `npm run smoke` (231 tests, 56 of them
new), `npm run build` all clean. Among the new ones: the closing block asserts
the address comes before the icons and the icons before the opt-out, that the
whole email contains the address once, four images and one "Unsubscribe", and
that the block is a single element a mail client cannot split. The four icons
were rendered and looked at, and the assembled email was rendered through the
send path's own functions with the PNGs inlined.

**Not verified against live data** — per the habit below, that means firing a
real send and reading what a publisher receives. The first campaign email after
this deploy is the one to check: one closing block, four icons visible, and the
text/plain part listing the four networks by name.

## Features added 17 August

- **Sent volume per mailbox, 7 / 14 / 30 days** (`src/mailboxes/volume.ts`,
  `mailbox-volume.tsx`). One `messages` query for the whole workspace, bucketed
  in memory — per-mailbox counts for three windows would otherwise be dozens of
  round trips. Windows **nest**: a send three days ago is in all three counts, so
  "last 14" can never read lower than "last 7". Warmup is counted separately from
  real outreach because both come through `sendEmail` into `messages` (warmup
  carries `meta.kind = 'warmup'`) and both spend the same daily budget — a
  mailbox at "5 / 5 today" with three real sends this week is correct, but only
  legible if both numbers are shown. The window toggle is **one control for the
  page**, not one per card: comparing mailboxes needs them on the same fortnight.
- **Duplicate campaign** (`/api/campaigns/duplicate`, button on the campaign
  page). Copies name, settings, `mailbox_ids` and every sequence step. Enrolments
  are **not** copied and the copy starts as a draft — a duplicate is for sending
  the same sequence to a *different* list, and carrying the old one over would
  re-enrol people who have already had it, or have two campaigns emailing the
  same contact mid-sequence. Copying a copy numbers it ("Outreach (copy 2)")
  rather than stacking suffixes. If the step insert fails the new campaign is
  deleted, because an empty campaign starts happily and sends nothing.

## Features added in earlier sessions

- **Send first batch now** (campaign page) — overrides the window for one run
  *and* releases `current_step = 0` contacts, because enrolment parks the first
  send at the next window opening. Only settable from the session-authenticated
  jobs route; cron can never bypass a window.
- **Warmup auto-starts** on mailbox connect (`enabled: true`,
  `ignoreDuplicates` so reconnecting cannot reset a ramp).
- **`sendingAllowance`** holds real sending to the volume warmup has reached
  while ramping. Folded into `daily_limit` at load so rotation's rules stay in
  one place. Warmup off = limit untouched.
- **Warmup conversations** — ~1 thread in 4 becomes 3–4 messages deep. The draw
  comes from the root message id, not a per-tick coin flip, so a thread's fate
  is stable across ticks. `reply_rate` now gates only whether a thread *starts*.
- **Paste import** — two boxes (websites / emails) paired row by row, plus a
  one-per-line mode. Blank lines are preserved while pairing: a blank cell
  mid-column would otherwise shift every later email onto the wrong website.
- **Per-domain address selection** — "keep 1 / 2 per domain". Named person beats
  shared inbox, editorial beats generic, noreply/privacy never kept. It
  **selects, never deletes**.
- **Prospecting filters** — status, HTTP response (403/404/429/500/any error/no
  response), no-emails, with shortcut counts. Selection to requeue, open in
  tabs, or delete.
- **Contacts** — manual add, bulk delete, delete-and-suppress, validate
  selected, re-check, stage column.
- **Merge-field buttons** on sequence editor and Compose. First name inserts
  `{{first_name|there}}` — a scraped `info@` has no name and "Hi ," is worse.
- **Per-mailbox pacing UI** — daily limit and gap range, up to 24h. Kept a
  *range* deliberately: an exact 120-minute beat reads as automation.
- **Timezone dropdown** (IANA via `Intl.supportedValuesOf`, offsets shown) and
  hour dropdowns with readable labels.
- **OAuth buttons** check configuration server-side and explain setup instead of
  returning raw JSON.

---

## Things deliberately not done

- **Gmail OAuth.** The client `Orankly CRM` exists in Google Cloud with a
  correct redirect URI, but the consent screen is **Testing** + **External**
  ("Make internal" greyed out — no Workspace). Google expires Testing-mode
  refresh tokens after **7 days**, so every mailbox would disconnect weekly.
  Production needs verification because `https://mail.google.com/` is a
  restricted scope. **App passwords are the right answer and already work.**
- **Outlook.** Microsoft removed basic auth and app passwords for personal
  Outlook.com; OAuth needs an Azure app registration and the user has no Azure
  account. Effectively unavailable.
- **Credentials.** I do not enter API keys, client secrets or app passwords into
  forms, and do not create accounts. `CRON_SECRET` and `APP_ENCRYPTION_KEY` were
  the exception — I generated those myself. **They were regenerated on 16 Aug,
  so the Desktop file "2 - VERCEL SETTINGS.txt" is stale for both.**

---

## Verification habits that earned their keep

`npm run typecheck && npm run smoke && npm run build` — **161 smoke tests**, all
pure logic, no DB or network.

Static checks alone were not enough. Every one of these was found only by
looking at live data or firing a real request:

- the DKIM false positive — visible only on the Deliverability page
- the inverted 13 → 12 window — visible only on the user's own campaign
- all three function timeouts — only by curling the endpoints
- the 5-from-one-mailbox bug — only by the user reading his sent folder

**Fire a real tick and read the notes.** `notes: []` versus
`["outside sending window"]` distinguishes "not due" from "window closed", and
that one line settled a question that two rounds of guessing had not.

```bash
curl -s -X POST https://crm.orankly.com/api/cron/campaigns -H "Authorization: Bearer $CRON_SECRET"
```

`CRON_SECRET` is in Vercel env vars and the GitHub repo secret.

Browser verification used Claude-in-Chrome against the user's logged-in session;
it dropped out repeatedly late on. The in-app Browser pane is **not** logged into
the CRM.
