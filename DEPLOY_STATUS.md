# Deployment status

Live record of the hosting setup, so any session can resume without re-deriving it.
Last updated: 2026-08-16.

**The app is live and fully configured at https://crm.orankly.com** (and
`https://outreach-crm-sandy.vercel.app`). Hosting is done; what is left is
first-run setup inside the app.

> **Start with `HANDOVER.md`** (17 Aug 2026) for the current state of the
> campaign, the pending work, and the scheduling rework. The scheduler section
> below is superseded: ticks now come from GitHub Actions every 10 minutes, not
> cron-job.org.

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

- [x] **`CRON_SECRET` and `APP_ENCRYPTION_KEY` set** (Production and Preview,
      marked Sensitive). Both were **regenerated on 2026-08-16** rather than
      reused from the Desktop file "2 - VERCEL SETTINGS.txt" — that file is now
      **stale for these two keys**. Rotating was free at this point because no
      mailbox was connected yet, so nothing had been encrypted with the old key.
      Verified end to end: `POST /api/cron/tick` returns `200 {"ok":true}` with
      the correct bearer token and `401 {"error":"Unauthorized"}` without it or
      with a wrong one.

## Remaining — inside the app, not the hosting

1. **Sign up** at https://crm.orankly.com/signup. There is no seeded admin
   account and no separate admin role. The first signup creates the account,
   the workspace, and the owner membership in one step, via the
   `handle_new_user()` trigger reading the `workspace_name` metadata. Because
   Supabase "Confirm email" is off, signup returns a session immediately and
   lands on `/dashboard` — no confirmation mail, no waiting.

2. ~~**Scheduler** — cron-job.org.~~ Superseded 17 Aug. Ticks come from
   `.github/workflows/tick.yml` every 10 minutes, calling the six per-job
   endpoints in parallel. No third-party account needed; it only requires the
   `CRON_SECRET` repository secret. `vercel.json` keeps a daily Vercel cron at
   `0 7 * * *` (noon Pakistan) as a safety net — Hobby rejects anything more
   frequent than daily, and an hourly expression made the very first deployment
   fail validation. See `HANDOVER.md` for why parallel rather than one tick.

3. **First run**: Settings → set the sending postal address (campaigns are
   hard-blocked until it is set) → connect **two or more** mailboxes → turn
   warmup on → let them warm 2–3 weeks before real volume.

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
