# Deployment status

Live record of the hosting setup, so any session can resume without re-deriving it.
Last updated: 2026-08-16.

**The app is live at https://crm.orankly.com** (and
`https://outreach-crm-sandy.vercel.app`). Two env vars are still missing —
see "Remaining" below.

## Decisions made

- **Host: Vercel.** Not Cloudflare Workers — Cloudflare blocks outbound SMTP
  ports and has no `node:dns`, which would break sending, IMAP polling, email
  validation, SPF/DKIM/DMARC and blacklist checks. Not Hostinger shared hosting
  either (no Node server). A Hostinger **VPS** would work if we ever move.
- **Domain: crm.orankly.com.** DNS for orankly.com is at **Hostinger**
  (`ns1/ns2.dns-parking.com`) — no Cloudflare in the path.

## Done

- [x] Supabase project **Outreach CRM** in the `Orankly` org (free plan).
      - ref: `rqztbqxzhykybnejjuba`
      - URL: `https://rqztbqxzhykybnejjuba.supabase.co`
      - region: `us-east-1` (co-located with Vercel's default `iad1`)
- [x] All six migrations applied. Verified: **23 tables, RLS on every one,
      4 policies each.**
- [x] Auth → **Confirm email turned OFF** (single-user tool; Supabase's built-in
      mailer is rate-limited and unreliable).
- [x] GitHub repo: **private**, `ihaseeb1/outreach-crm`, branch `main`.
- [x] **Vercel GitHub App** installed on `ihaseeb1`, scoped to that one repo.
      Vercel's account-level GitHub *login connection* is also linked.
- [x] **Vercel project `outreach-crm`** (Orankly team, Hobby), Git-connected,
      preset Next.js, production branch `main`, Node 24.x.
- [x] **Deploys work.** Pushes to `main` build automatically.
- [x] **Supabase↔Vercel integration re-linked** (Supabase org → Integrations →
      Vercel → project connection `Outreach CRM → outreach-crm`). It injects
      `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
      `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SECRET_KEY`,
      `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_JWT_SECRET` and POSTGRES_*.
      These are **Production-scope only** — Preview deployments have no
      Supabase config.
- [x] Hand-set env vars: `NEXT_PUBLIC_APP_URL` = `https://crm.orankly.com`,
      `NEXT_PUBLIC_SUPABASE_URL` (Production **and** Preview).
- [x] **Domain `crm.orankly.com` added and verified.** Hostinger DNS Zone has
      `CNAME crm → cb124a17c92eaf47.vercel-dns-017.com.` (TTL 14400).
      Vercel shows "Valid Configuration"; HTTPS serves a 200 and redirects to
      `/login`.

## Remaining

1. **Two env vars are still unset** — the agent does not type secrets into
   forms, so these must be added by hand at
   Vercel → outreach-crm → Settings → Environment Variables → Add:

   | Variable | Value |
   | --- | --- |
   | `CRON_SECRET` | in Desktop file "2 - VERCEL SETTINGS.txt" |
   | `APP_ENCRYPTION_KEY` | in Desktop file "2 - VERCEL SETTINGS.txt" |

   Scope them to **Production** (Preview too if you want preview builds to
   work). Then **redeploy** — Vercel only applies env changes to new builds.

   Without them the app still signs in and browses fine; what breaks is
   `/api/cron/*` (needs `CRON_SECRET`) and connecting a mailbox (needs
   `APP_ENCRYPTION_KEY`, which encrypts stored credentials). If
   `APP_ENCRYPTION_KEY` is ever changed or lost, every connected mailbox must
   be reconnected — so set it once and keep the value.

2. **Scheduler** — point cron-job.org (free) at
   `https://crm.orankly.com/api/cron/tick` every 5–10 minutes, with header
   `Authorization: Bearer <CRON_SECRET>`. Do this after step 1.
   `vercel.json` also declares a daily Vercel cron as a safety net (Hobby
   rejects anything more frequent than once a day — an hourly expression made
   the whole deployment fail validation).

3. **First run in the app**: sign up → Settings → set the sending postal address
   (campaigns are hard-blocked until it is set) → connect **two or more**
   mailboxes → turn warmup on → let them warm 2–3 weeks before real volume.

## Notes for future sessions

- **The dashboard import flow creates the project but does not start a
  deployment.** It happened twice. The "Deploy" button returns no visible
  feedback the first time and then errors with *"Project already exists"* on a
  second click — because the first click did create it. Do not re-delete the
  project over this; check
  `vercel.com/orankly/outreach-crm/deployments` instead.
- **Deploy Hook `manual-main`** (Settings → Git → Deploy Hooks) triggers a
  production build on `main` with a plain `POST`, no auth, no CLI. That is the
  reliable escape hatch when the dashboard misbehaves.
- The import screen pre-fills **17 env vars parsed out of `.env.example`, all
  with empty values**. Remove the ones you are not filling in — otherwise the
  project ends up with a pile of empty vars that look configured and are not.
- `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_SUPABASE_URL` were created with
  Vercel's **"Sensitive value"** toggle on (it defaults to on), so their values
  cannot be read back in the dashboard — only replaced. Harmless for these two,
  since `NEXT_PUBLIC_*` values are inlined into the client bundle anyway.
- `src/lib/env.ts` accepts either naming scheme (`firstOf(...)`), so the
  integration's names and the `.env.example` names both work, with a hand-set
  value winning.
