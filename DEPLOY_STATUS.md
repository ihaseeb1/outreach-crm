# Deployment status

Live record of the hosting setup, so any session can resume without re-deriving it.
Last updated: 2026-08-16.

## Decisions made

- **Host: Vercel.** Not Cloudflare Workers — Cloudflare blocks outbound SMTP
  ports and has no `node:dns`, which would break sending, IMAP polling, email
  validation, SPF/DKIM/DMARC and blacklist checks. Not Hostinger shared hosting
  either (no Node server). A Hostinger **VPS** would work if we ever move.
- **Domain: crm.orankly.com.** DNS for orankly.com is at **Hostinger**
  (`ns1/ns2.dns-parking.com`) — no Cloudflare in the path. The subdomain record
  gets added in hPanel.

## Done

- [x] Supabase project **Outreach CRM** created in the `Orankly` org
      (free plan, 2nd of 2 projects).
      - ref: `rqztbqxzhykybnejjuba`
      - URL: `https://rqztbqxzhykybnejjuba.supabase.co`
      - region: `us-east-1` (co-located with Vercel's default `iad1`)
- [x] All six migrations applied via the SQL editor, in order.
      Verified: **23 tables, RLS enabled on every one, 4 policies each.**
- [x] Auth → **Confirm email turned OFF** (single-user tool; Supabase's built-in
      mailer is rate-limited and unreliable).
- [x] GitHub repo created: **private**, `ihaseeb1/outreach-crm`.
- [x] Local git configured with the GitHub remote, branch `main`.

- [x] **Code pushed to GitHub.** Verified: remote `main` = local `5ccae11`
      (all 7 phase commits).
- [x] **Vercel GitHub App installed** on the `ihaseeb1` account (confirmed at
      github.com/settings/installations). The install page appeared to "loop",
      but it did succeed.

## Blocked / next

1. **Link Vercel's GitHub login connection.** This is the current blocker.
   The GitHub *App* is installed, but Vercel's account-level *login connection*
   is not, so vercel.com/new still shows "Continue with GitHub" and the
   import-by-URL Deploy button hangs.

   Fix at: https://vercel.com/account/login-connections → connect GitHub.
   (Popups launched from the automated tab kept landing outside the controllable
   tab group, which is why this is left to the user.)

   Vercel team is **Orankly** (Hobby). Do NOT use the "clone" flow at
   `/new/clone` — it creates a duplicate repo instead of importing the existing
   one.

2. **Import the repo into Vercel** (vercel.com/new → pick `outreach-crm`).

3. **Environment variables in Vercel.** Six values:

   | Variable | Where it comes from |
   | --- | --- |
   | `NEXT_PUBLIC_SUPABASE_URL` | `https://rqztbqxzhykybnejjuba.supabase.co` |
   | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase → Project Settings → API (publishable/anon) |
   | `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API (**secret**) |
   | `CRON_SECRET` | generate (see below) |
   | `APP_ENCRYPTION_KEY` | generate (see below) |
   | `NEXT_PUBLIC_APP_URL` | `https://crm.orankly.com` |

   Generate the two secrets:

   ```bash
   node -e "console.log('CRON_SECRET='+require('crypto').randomBytes(32).toString('hex'));console.log('APP_ENCRYPTION_KEY='+require('crypto').randomBytes(32).toString('hex'))"
   ```

   **Note:** the agent does not copy the user's secret keys between sites. Either
   the user pastes the two Supabase keys, or the Vercel↔Supabase integration is
   used, which passes them machine-to-machine.

   `APP_ENCRYPTION_KEY` encrypts stored mailbox credentials — if it is ever
   changed or lost, every connected mailbox must be reconnected.

4. **Domain** — add `crm.orankly.com` in Vercel, then in Hostinger hPanel →
   Domains → DNS Zone add the CNAME Vercel shows (usually
   `crm` → `cname.vercel-dns.com`).

5. **Scheduler** — point cron-job.org (free) at
   `https://crm.orankly.com/api/cron/tick` every 5–10 minutes, with header
   `Authorization: Bearer <CRON_SECRET>`. Vercel Hobby only fires cron once a
   day, which is too coarse.

6. **First run in the app**: sign up → Settings → set the sending postal address
   (campaigns are hard-blocked until it is set) → connect **two or more**
   mailboxes → turn warmup on → let them warm 2–3 weeks before real volume.
