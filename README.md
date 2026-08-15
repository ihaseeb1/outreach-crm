# Outreach CRM

Self-hosted cold outreach, mailbox warmup, and link-building CRM. Scrapes
websites for contacts, validates them, runs multi-step campaigns across your own
mailboxes, warms those mailboxes up, lands replies in one inbox, and records
publisher deals that export straight to Excel.

Built entirely on free tiers: Next.js on Vercel, Supabase Postgres, SMTP/IMAP
against mailboxes you already own.

## Stack

| Concern      | Choice                                                        |
| ------------ | ------------------------------------------------------------- |
| Language     | TypeScript (strict)                                           |
| Framework    | Next.js App Router — UI, API routes, and jobs in one codebase  |
| Database     | Supabase Postgres, versioned SQL migrations, RLS on every table |
| Auth         | Supabase Auth (email + password)                              |
| Sending      | `nodemailer` over SMTP behind a `MailboxProvider` interface    |
| Receiving    | `imapflow`, polled on a schedule                              |
| Scraping     | `fetch` + `cheerio` behind a `Scraper` interface               |
| Validation   | `dns.resolveMx` + `validator` + disposable-domain blocklist    |
| Jobs         | Cron-triggered, bounded, idempotent batches                    |
| Excel        | SheetJS (`xlsx`) downloads + TSV copy-to-clipboard             |

## Setup

### 1. Supabase project

1. Create a free project at [supabase.com](https://supabase.com).
2. Open **SQL Editor** and run each file in `supabase/migrations/` in filename
   order.
3. Copy the Project URL, `anon` key, and `service_role` key from
   **Project Settings → API**.
4. Optional (single-user setups): **Authentication → Providers → Email** →
   turn off *Confirm email* so signup logs you straight in.

### 2. Environment

```bash
cp .env.example .env.local
```

Fill in the Supabase values, then generate the two secrets:

```bash
node -e "console.log('CRON_SECRET=' + require('crypto').randomBytes(32).toString('hex')); console.log('APP_ENCRYPTION_KEY=' + require('crypto').randomBytes(32).toString('hex'))"
```

`APP_ENCRYPTION_KEY` encrypts mailbox credentials at rest — if you lose it, every
connected mailbox has to be reconnected.

### 3. Run

```bash
npm install
npm run dev
```

Open http://localhost:3000, sign up, and you get a workspace automatically.

## Background jobs

Serverless functions time out, so nothing runs in a long-lived loop. Every job
processes a bounded batch and returns; state lives in Postgres. Jobs are
idempotent, so overlapping ticks are safe.

| Endpoint              | Does                                           |
| --------------------- | ---------------------------------------------- |
| `/api/cron/tick`      | Dispatcher — runs a slice of every due job      |
| `/api/cron/scrape`    | Scrapes a batch of pending websites             |
| `/api/cron/validate`  | Validates a batch of contacts                   |
| `/api/cron/inbound`   | Polls mailboxes over IMAP for replies           |
| `/api/cron/campaigns` | Sends the next due sequence step                |
| `/api/cron/warmup`    | Ramps, sends, engages, rescues from spam, replies |
| `/api/cron/health`    | Daily reputation check per mailbox              |

All of them require `Authorization: Bearer $CRON_SECRET` (or `?secret=` for
local testing).

**Scheduling on the free tier.** Vercel's Hobby plan only triggers cron jobs once
a day, which is far too coarse for outreach. `vercel.json` keeps an hourly entry
(which Hobby will down-throttle to daily) as a safety net; for real cadence point
a free external scheduler at the tick endpoint every 5–10 minutes:

- [cron-job.org](https://cron-job.org) — free, supports custom headers
- GitHub Actions on a `schedule:` trigger with `curl`
- A Cloudflare Worker with a cron trigger

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/cron/tick
```

## Compliance

These are enforced in code, not by convention:

- **Suppression list** — `canSend()` in `src/mail/guard.ts` is the only route to
  a send. It checks syntax, disposable domains, and the suppression list, and
  refuses campaign mail when no postal address is configured.
- **Postal address** — required in Settings before any campaign can send.
- **robots.txt** — honoured per site, with `Crawl-delay` respected and a floor of
  `SCRAPER_CRAWL_DELAY_MS`, plus a descriptive `User-Agent`.
- **Source tracking** — every contact stores `source_url` and `scraped_at`.
- **Secrets** — mailbox credentials are AES-256-GCM encrypted at rest and never
  logged.

## Connecting mailboxes

Two options, and you can mix them:

**App password (simplest).** Mailboxes → Connect a mailbox. For Gmail, turn on
2-Step Verification, create an App Password, and make sure IMAP is enabled in
Gmail settings. Credentials are verified against the real SMTP *and* IMAP servers
before anything is stored, then encrypted with AES-256-GCM.

**OAuth2.** Needed on Microsoft tenants that have disabled basic auth, and
generally more robust. Set the client id/secret in the environment (see
`.env.example`), register the redirect URI with the provider, then use
**Connect Gmail** / **Connect Microsoft 365** on the Mailboxes page. Only the
refresh token is stored; access tokens are fetched on demand.

There is no limit on how many mailboxes you connect. Campaigns rotate across
every active one, and warmup pairs them with each other.

## Warmup and the unified inbox

Warmup is a closed loop between your own mailboxes — there is no paid pool.
They email each other, open and flag what arrives, **move anything that lands in
spam back to the inbox**, and reply to a configurable fraction. Volume starts at
5/day and climbs slowly; it never spikes, because providers detect artificial
warmup and a jump is the clearest tell there is.

Warmup traffic carries a signed `X-OCRM-Warmup` header and is tracked separately
from real mail. **The unified inbox contains genuine replies only** — warmup,
bounce notifications, out-of-office autoresponders, and the mailbox owner's
ordinary personal correspondence are all filtered out before anything becomes a
conversation.

## Dynamic scraping (optional)

The default scraper is `fetch` + `cheerio`, which handles the large majority of
publisher sites. Sites that render contact details with JavaScript need
Playwright — which **cannot run on Vercel**: a serverless function has no
persistent browser and Chromium exceeds the bundle limit.

Run it instead on any always-on machine (a Hostinger VPS, a home server, a
Raspberry Pi). It talks to the same Supabase database and uses the same batch
runner, so work queued in the UI is picked up automatically:

```bash
git clone <your-repo> && cd outreach-crm
npm install
npm install playwright
npx playwright install --with-deps chromium
```

Create a `.env.local` with `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
and the `SCRAPER_*` values, then:

```bash
npm run scrape-worker
```

To keep it running after you log out, use a systemd unit or `pm2 start "npm run scrape-worker" --name scraper`.

## Deploy

1. Push to GitHub, import the repo in Vercel.
2. Add every variable from `.env.example` in the Vercel project settings.
3. Set `NEXT_PUBLIC_APP_URL` to the production URL.
4. Point Cloudflare DNS at Vercel if you are using a custom domain.

## Project layout

```
src/
  app/            routes: UI pages, API routes, cron endpoints
  campaigns/      sequences, sending, rotation      (phase 3)
  crm/            pipeline, notes, tasks            (phase 6)
  deals/          rate cards and exports            (phase 5)
  health/         SPF/DKIM/DMARC, blacklists        (phase 4)
  lib/            env, supabase clients, crypto, cron auth, activity log
  mail/           canSend guard, suppressions, providers, IMAP
  scraper/        Scraper interface, robots.txt, extraction, batch runner
  validation/     syntax + MX + disposable checks
  warmup/         peer warmup engine                (phase 4)
```

See `BUILD_LOG.md` for what each phase delivered and what is outstanding.
