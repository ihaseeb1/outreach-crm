# Handover — 17 August 2026

Read this first, then `DEPLOY_STATUS.md` for hosting and `BUILD_LOG.md` for the
original seven build phases.

Live at **https://crm.orankly.com**. Everything below is deployed on `main`.

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

### Two things the user must confirm are done

1. **`CRON_SECRET` as a GitHub repository secret** — the user said they added it.
   Verify a green run under Actions → "Cron tick". Without it nothing ticks.
2. **Warmup target is 5/day on every mailbox**, so all four originally checked
   read "5 → 5, fully warmed". 5/day is not a warmup. The schema default is 40.
   Raise it in Deliverability. Until then `sendingAllowance` sees "warmed" and
   hands straight back to the daily limit, protecting nothing.

---

## Pending work

Both items below were **built on 17 August** and are committed on `main`.
Nothing else is outstanding from the previous list.

1. ~~Mailbox sent-volume views: 7 / 14 / 30 days.~~ Done — see below.
2. ~~Duplicate campaign.~~ Done — see below.

**Not yet verified against live data.** Everything passes typecheck, 161 smoke
tests and a production build, but neither feature has been looked at on
crm.orankly.com. Per the habits at the bottom of this file, that is not the same
as working. Check the volume numbers against a mailbox's real sent folder, and
duplicate a campaign to confirm the copy has the steps and no contacts.

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
