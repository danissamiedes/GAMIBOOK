# Ledger

Small-business accounting with consultant time tracking. Built to `SPEC.md`;
decisions and deviations are recorded in `DECISIONS.md`.

The point of this system is a real double-entry general ledger — a Profit &
Loss and a Balance Sheet that are correct in the same sense QuickBooks' are,
not estimated from a list of categorised transactions.

## Status

**Phases 1–9 are complete.** What works today:

- Multi-company data model — Organization → Company → Membership, roles per
  company (`OWNER`, `BOOKKEEPER`, `CONSULTANT`)
- **Section access** — Sales, Consultants, Vendors, Banking, Reports, Settings
  granted per membership. A bookkeeper with only Vendors cannot reach a
  customer or an invoice, by menu or by URL
- `withCompanyScope()` — the single data-access guard every query goes through
- Auth.js sign-in with Argon2id passwords, rate-limited; optional Google sign-in
- Invitations (7-day expiry) and self-service password reset, both setting the
  password on first use
- Company setup wizard: base currency (permanent), fiscal year, both time zones
- Company switcher, role middleware, append-only audit log
- Storage adapter with local-disk and S3 implementations
- Seed script and the Phase 1 test: a user in company A cannot read company B

**Phase 2 — the ledger:**

- Chart of accounts: per-company, with a default template of ~30 accounts
  including every system account the app posts to automatically
- `postJournalEntry()` — the single posting service. Nothing else writes a
  journal line
- Balance, immutability and one-side-per-line rules enforced by **database
  constraints and triggers** as well as in code, so a bug or a psql prompt
  cannot break the books
- Manual journal entries with a keyboard-first line editor and live difference
- Reversal (posted entries are never edited), opening balances with the
  difference plugged to Opening Balance Equity
- Gap-free per-company numbering, safe under concurrent posting
- **Trial Balance** with date range, CSV export and a loud banner if it ever
  fails to balance

**Phase 3 — money in:**

- Customers with their own currency and payment terms; light items/services
- Invoices with the full status machine. Issuing — not emailing — allocates the
  number and posts to the ledger, in one transaction
- Payments with applications, so one payment can settle several invoices;
  over-payment is kept as a credit on account, never discarded
- Payment reversal: posts a reversing entry, deletes nothing, recomputes every
  invoice it touched
- Void posts a full reversal and keeps the number reserved; blocked while
  payments are applied
- **FX on the receivables side** (the live path for PHP books with USD clients):
  A/R is relieved at the invoice's historic rate, the cash leg uses the
  payment's rate, and the difference books to Realized FX Gain/Loss. Partial
  payments relieve pro rata, with the final payment taking the residual so the
  control account lands exactly on zero
- Line-rounding residual posts to FX Rounding Difference rather than distorting
  revenue
- **A/R Aging** per customer with CSV export, which checks itself against the
  A/R control account and says so if the two disagree

**Phase 4 — money out:**

- One `Vendor` table with `kind` = `CONSULTANT` or `REGULAR`. Consultant-only
  fields (default rate, time-clock link, email recipients, import aliases) sit
  on the same record, and the kind filter lives in the data layer — the
  Consultants section never sees a regular vendor and vice versa
- Work orders: description / quantity / rate lines, each naming its own
  account, and **negative lines** for a cash advance being recovered. Approval
  allocates `WO1001` onward and posts the A/P entry **dated the work order
  date**, not the day you clicked approve
- Bill payments settling work orders and vendor bills alike, with reversal
- Expenses in both shapes — `DIRECT` (paid as recorded) and `BILL` (owed, then
  cleared) — as two forms sharing one model
- FX on the payables side: a PHP work order in USD books relieves A/P at the
  work order's rate, cash at the payment's rate, difference to Realized FX
- **A/P Aging** per vendor, filterable by kind, pinned to whichever side the
  viewer's sections allow

**Phase 5 — reports:**

- **Profit & Loss**, accrual basis, with an optional prior-period comparison
  column and % of income
- **Balance Sheet** with the equity rule spelled out in SPEC §12.2: net income
  measured from the start of the fiscal year *containing the as-of date*, and
  retained earnings as the account's own balance **plus** every prior year's
  profit rolled forward from the ledger. It asserts `Assets = Liabilities +
  Equity` and shows a loud banner if it ever fails
- **General Ledger** and account detail with a running balance and opening figure
- **Drill-down everywhere**: click any figure on the P&L, Balance Sheet, Trial
  Balance or GL to see the journal lines behind it, then click a line to open
  the invoice, work order or expense that created it
- CSV export on every report, plus a print stylesheet until the PDF renderer
  lands in Phase 7

**Phase 6 — time tracking:**

- Consultant login lands on the time clock and can reach nothing else. Big
  ticking clock, one button, today's total and this week's, their own last 30
  days read-only, and a correction request they can attach to a row
- Every time is rendered in the company's `timeClockTimeZone` with the zone
  named, for every viewer, whatever their browser says
- **The work day is the local calendar date the shift started on.** A shift
  from 23:30 to 01:15 counts entirely on the day it began — tested, and visible
  in the seeded data
- Admin timesheet grid (consultant × day) with totals, entry add/edit keeping
  the original values plus who changed them and why, open-shift alerts, and
  correction requests surfaced for review
- Auto-close for a shift left running past the company's `maxShiftHours`,
  flagged rather than silently guessed
- Time report with CSV export, and an in-process job scheduler that Phase 8's
  recurring invoices will reuse

**Sales orders, sales-by-customer and consultant bills:**

- **Sales orders** (§7.1a) — record what a customer agreed to buy. Confirming
  allocates `SO1001` onward and **posts nothing**; converting produces a draft
  invoice, and issuing that is what finally recognises revenue
- **Sales by customer** (§12.8) — invoiced, paid and outstanding per customer
  for a period, in base currency, excluding drafts and voids. Lives in the
  Sales section
- **Consultant bills** — an amount owed to a consultant that is not a work
  order (a reimbursement, an agreed cost). Same document as a vendor bill,
  same A/P, same payment machinery; visible only in the Consultants section

**Phase 7 — documents and email:**

- **PDFs** for invoices, work orders and payment receipts, with company
  branding (logo, address, tax number, footer). Rendered with React-PDF rather
  than headless Chrome, so there is no browser in the container and the Vercel
  path stays open
- PDF export for the Trial Balance, P&L and Balance Sheet
- Generated PDFs are a **cache**: deleting one loses nothing, and changing
  branding clears them so they regenerate
- **Gmail sending** from your own mailbox — OAuth with only the `gmail.send`
  scope, so the app cannot read your mail. Refresh tokens are held under
  envelope encryption; a database dump alone decrypts nothing
- Per-company email templates with live preview, placeholder substitution and
  a "send test to myself" button
- `EmailLog` for every attempt, with the reason when one fails
- Send from an invoice or a work order; `lastEmailedAt` is stamped only on
  success, and a consultant marked not-to-be-emailed is refused by name

**Phase 8a — Excel work-order import:**

- Upload `.xlsx` or `.csv` in **your own layout** — Work Order Date, Consultant
  Name, Line No., Description, Account, Quantity, Rate, Amount
- **`Line No.` grouping**: 1 opens a work order for that consultant, 2, 3 …
  continue it, tracked per consultant so rows may interleave
- Each line posts to the account its row names, and a **negative rate is a
  deduction** — a cash advance being recovered
- Upload never writes documents. Rows are staged and validated, the report
  shows every row with what it was understood to mean, and errors block only
  their own row. Rejected rows download as a workbook with a reason column
- Unknown consultant spellings are mapped once and remembered on that
  consultant, so the next sheet matches automatically
- Imports create **drafts**; approving them is what posts, and bulk approve
  handles a batch with per-document failures reported individually
- Re-importing the same file warns loudly rather than silently duplicating, and
  a batch can be undone while its drafts are untouched
- A downloadable template carries this company's own consultant and account
  names

`npm run seed` writes `fixtures/work-orders-september-2026.xlsx` — five good
rows and three deliberately broken ones — to try it against.

**Phase 8b — bulk work-order send:**

- A filterable work order list — status, consultant, date range, import batch,
  and **"never emailed"** as the default working filter — with a checkbox per
  row
- Each row shows **where that email would go**, resolved from the consultant's
  own setup. A consultant who cannot be emailed is greyed out with the reason
  and cannot be selected
- **One email per work order** by default, or one per consultant with all their
  PDFs attached — a toggle, both implemented
- A confirmation step naming the email count, consultant count and address
  count, with the rendered subject, and a warning when the selection includes
  unapproved drafts
- Sending is throttled, a partial failure never aborts the batch, and
  **"retry failed only"** cannot re-send anything that already succeeded
- Every message writes its own `EmailLog` row under one batch;
  `lastEmailedAt` is stamped only on success
- Attachments over 20 MB for one consultant fail that message with a clear
  reason rather than being rejected by Gmail

**Phase 9 — dashboard and polish:**

- **Dashboard** — cash on hand, six months of income against expenses, what is
  owed to you and what you owe with their overdue portions, and who is on the
  clock right now. Every tile is section-gated in the data layer: a tile you
  may not see is absent, never a zero
- **Full data export** — a zip of twenty CSVs covering everything the company
  holds, with a README naming which file is authoritative. Owner only, since
  the archive crosses every section boundary at once
- **Mobile pass** — no screen scrolls the page sideways, and every control is
  44px on a touch device while staying dense for a mouse
- **Line editor keyboard** — Tab from the last field adds a row *and lands in
  it*, Enter moves down instead of submitting the document, Ctrl/⌘ + Backspace
  removes a row
- **Empty states** that distinguish "nothing yet" from "nothing matches this
  filter", and say what to do about either
- Playwright end-to-end tests for the flows only a browser can check

The dashboard has no unmatched-bank-lines tile: it counts rows from the CSV
bank import, which is deferred, and "0 unmatched" would read as reconciled
books rather than as a missing feature.

**Recurring invoices (§7.2):**

- A template plus a schedule — weekly, fortnightly, monthly, quarterly, annual
  — with an end date, an occurrence limit and a pause switch
- **Drafts by default.** Issuing and sending automatically is opt in per
  template, because an invoice that posts revenue and reaches a customer
  unread is a different kind of mistake from a wrong draft
- The daily job runs at 06:00 in each company's **own operating zone**, and is
  idempotent on `(template, scheduled date)` — a double run cannot invoice
  twice, enforced by a unique constraint rather than a check-then-write
- A template that has not run for months catches up one invoice per period,
  because each period genuinely happened
- "Coming in the next 30 days", with anything already past flagged as overdue —
  which is how you notice the scheduler is not running

**CSV bank import (§8.4):**

- A bank account per real account, tied to the ledger account its cash sits in
- Column mapping with a live preview, both statement layouts (one signed
  column, or separate debit and credit), and a date format you choose — the
  mapping is saved per account so the next import is one click
- Dedupe on (account, date, amount, description), so a re-imported overlap is
  reported rather than duplicated
- **Three match outcomes, and they do not overlap:** link to a payment already
  recorded (posts nothing), settle an open document (creates the payment), or
  categorise directly (posts against the bank). Unmatching reverses whatever
  the match created, and nothing when it created nothing
- Unmatched count on the dashboard and beside each account

**The spec is complete.** The historical migration (§4.4) is not built and is
not needed — the books start empty, so going live is opening balances at a
chosen date. Connecting Gmail is the only outstanding setup step, and it gates
delivery alone: composing, attaching, previewing and logging all work without
it.

### Connecting Gmail

Sending needs a Google Cloud OAuth client. Until one is configured, everything
works in dry-run: emails are composed, logged and previewable, and nothing
leaves the machine.

1. In the Google Cloud console, create an OAuth 2.0 Client ID (Web application).
2. Add `https://your-domain/api/email/google/callback` as an authorised redirect
   URI — and `http://localhost:3000/api/email/google/callback` for development.
3. Put the client id and secret in `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET`.
4. Set `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`) — refresh tokens are
   not stored without it.
5. Set `EMAIL_DRY_RUN=false` when you actually want mail to go out.
6. Connect the mailbox under Settings → Email.

`docs/gmail-setup.md` walks the console screens step by step, including which
consent-screen type to pick and what each OAuth error means.

To check the wiring without clicking through the app:

```bash
npm run email:check                  # what is configured, what is missing
npm run email:check you@example.com  # plus one real test message
```

## Local setup

Requires Node 22+ and Postgres 16 (or Docker).

```bash
cp .env.example .env          # then set AUTH_SECRET: openssl rand -base64 32
docker compose up -d db       # or point DATABASE_URL at your own Postgres
npm install
npx prisma migrate deploy     # create the schema
npm run seed                  # sample org, two companies, users
npm run dev                   # http://localhost:3000
```

`npm run seed` prints the login credentials it created. The two seeded
companies are deliberately different: one keeps its books in **PHP** (the
production shape — consultants paid in PHP, clients invoiced in PHP or USD) and
one in **USD**, so the FX path is exercised in both directions.

### Everything from a clean clone

```bash
npm install && npx prisma migrate deploy && npm run seed && npm test && npm run build
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Generate the Prisma client and build for production |
| `npm start` | Run the production build |
| `npm test` | Vitest suite (needs `TEST_DATABASE_URL`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm run seed` | Seed the development database |
| `npm run db:migrate` | Create and apply a migration in development |
| `npm run db:deploy` | Apply existing migrations (used on boot in Docker) |
| `npm run db:reset` | Drop, re-migrate and re-seed |
| `npm run bootstrap` | Create the first owner on a fresh deployment. Refuses if any user exists |
| `npm run test:e2e` | Playwright suite — starts its own dev server |
| `npm run email:check` | What Gmail sending is missing; with an address, sends a test |

Tests run against `TEST_DATABASE_URL`, never the development database, and
migrate it automatically before the first test file.

## Deployment (single VPS)

The simplest way to run this: one always-on container next to one Postgres.
Nothing has to be arranged around a host that discards its filesystem and its
process between requests — the scheduler is timers, storage is a mounted volume,
and backups are a file you can copy. [Vercel](#deployment-vercel) is supported
too, and needs three services instead of one.

A 2 GB box is enough. These steps take about ten minutes.

**1. Point a domain at the server.** An `A` record for `books.example.com` at
the server's IP. Do this first: Caddy asks Let's Encrypt for a certificate the
moment the stack starts, and that only works once DNS resolves.

**2. Install Docker and clone.**

```bash
curl -fsSL https://get.docker.com | sh
git clone https://github.com/danissamiedes/GAMIBOOK.git /srv/ledger
cd /srv/ledger
```

**3. Write the secrets.** Generate them on the server — a key that has passed
through a chat window or a shared document is not a secret any more.

```bash
cp .env.example .env
printf 'AUTH_SECRET="%s"\n'          "$(openssl rand -base64 32)" >> .env
printf 'TOKEN_ENCRYPTION_KEY="%s"\n' "$(openssl rand -base64 32)" >> .env
printf 'POSTGRES_PASSWORD="%s"\n'    "$(openssl rand -base64 24)" >> .env
printf 'LEDGER_DOMAIN="%s"\n'        "books.example.com"          >> .env
chmod 600 .env
```

**4. Start it.**

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

The app applies its migrations on boot, and Caddy obtains the certificate. Watch
it come up with `docker compose -f docker-compose.prod.yml logs -f`.

**5. Create the first owner.** There is no signup page — you get in by
invitation, which means someone has to exist first. Do **not** run `npm run
seed` here: that is the development fixture, with demo companies and a shared
password.

```bash
docker compose -f docker-compose.prod.yml exec app npm run bootstrap
```

It asks for an email, a name and a password, creates one organization, one
owner and one empty company with the default chart of accounts, and refuses to
run at all if the database already has a user. Sign in at
`https://books.example.com` and you land on the setup wizard, where you choose
the base currency — that choice is permanent.

From there, invite everyone else from **Settings → Users**.

### What the production compose file does differently

`docker-compose.yml` is the development one. `docker-compose.prod.yml` is a
separate file rather than an overlay, because the differences are the kind you
want to read in one place rather than infer from two:

- **Postgres is not published.** The development file maps 5432 to the host so
  `npm run dev` and `npm run seed` can reach it. On a public box that is the
  database on the internet.
- **No secret has a default.** The stack refuses to start rather than coming up
  with the password `ledger` because a variable was missing.
- **Caddy terminates TLS** and is the only thing listening on 80 and 443.
  Session cookies are marked `Secure` in production, so sign-in genuinely does
  not work over plain HTTP on a real domain.
- **`SCHEDULER_ENABLED` defaults to true**, because this file runs exactly one
  app container. Recurring invoices and stale-shift auto-close do not happen
  without it. If you ever run a second instance, set it to `false` on all but
  one — every job would otherwise run several times.

Three volumes hold state:

- `db-data` — Postgres. **This is the books.**
- `storage-data` — receipts, logos, uploaded import files, cached PDFs.
  Generated PDFs are regenerable; receipts and import files are not.
- `caddy-data` — the issued certificates. Losing it means re-issuing on the
  next boot, and Let's Encrypt rate-limits that.

### Updating

```bash
cd /srv/ledger && git pull
docker compose -f docker-compose.prod.yml up -d --build
```

Migrations run on boot, so the schema never lands behind the code. Take a backup
first — see below — because a migration is the one deploy step that cannot be
rolled back by redeploying the previous image.

## Deployment (Vercel)

Vercel runs the app as short-lived functions rather than a server, which changes
four things. All four are handled — this is a supported target, not a
workaround — but each needs something the VPS path does not.

You will need three accounts, all with a free tier that covers a small business:
**Vercel**, a Postgres host (**Neon** — Vercel Postgres is Neon underneath), and
an S3-compatible bucket (**Cloudflare R2**, which has no egress charges).

**1. Create the database.** In Neon, make a project and copy **both** connection
strings from the dashboard: the **pooled** one (its host contains `-pooler`) and
the **direct** one. Serverless multiplies instances and each opens its own
connections, so the app uses the pooled URL; migrations need a session the
pooler will not give them, so they use the direct URL.

**2. Create the bucket.** In Cloudflare R2, make a bucket and an API token with
object read and write. Note the bucket name, the account endpoint
(`https://<account-id>.r2.cloudflarestorage.com`), and the key pair. **This is
not optional.** A serverless filesystem does not survive between requests, so
the local-disk driver would accept every upload and lose receipts and imported
bank statements with no error at all. The app refuses to start that combination
rather than let it happen quietly.

**3. Import the repository into Vercel** — New Project, pick the repo, framework
Next.js, and do not deploy yet.

**4. Set the environment variables.** Generate the secrets on your own machine;
a key that has been pasted into a chat window or a shared document is not a
secret any more.

```bash
openssl rand -base64 32   # AUTH_SECRET
openssl rand -base64 32   # TOKEN_ENCRYPTION_KEY
openssl rand -base64 32   # CRON_SECRET
```

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon's **pooled** string, with `?sslmode=require&pgbouncer=true` |
| `DIRECT_DATABASE_URL` | Neon's **direct** string, with `?sslmode=require` |
| `AUTH_SECRET` | generated above |
| `AUTH_URL` | `https://your-project.vercel.app` — update it if you add a domain |
| `TOKEN_ENCRYPTION_KEY` | generated above |
| `CRON_SECRET` | generated above |
| `STORAGE_DRIVER` | `s3` |
| `S3_BUCKET` | your R2 bucket name |
| `S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `S3_REGION` | `auto` |
| `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` | the R2 token pair |
| `S3_FORCE_PATH_STYLE` | `true` |
| `EMAIL_DRY_RUN` | `true` until Gmail is connected |
| `SCHEDULER_ENABLED` | leave unset — see **Scheduled jobs** below |

**5. Deploy.** The build runs `prisma generate && prisma migrate deploy && next
build`, so the schema is created as part of the first deploy and can never land
behind the code.

**6. Create the first owner.** There is no signup page. Run this from your own
machine, pointed at the production database:

```bash
DATABASE_URL="<the direct Neon string>" npm run bootstrap
```

Then sign in at your Vercel URL, and you land on the setup wizard.

### Scheduled jobs on Vercel

The in-process scheduler cannot work where there is no process between
requests, so `/api/cron` does the same work when something outside knocks. It
authenticates with `CRON_SECRET` and runs every job; each one is idempotent, so
calling it more often than needed is harmless and calling it late delays work
rather than losing it.

`vercel.json` registers an hourly cron, and Vercel sends `CRON_SECRET` as a
Bearer token by itself. **On the Hobby plan, Vercel runs cron jobs once a day**,
which is fine for recurring invoices and not fine for closing a shift someone
forgot to clock out of. Either move to Pro, or point any external pinger at it:

```
GET https://your-project.vercel.app/api/cron
    x-cron-key: <CRON_SECRET>
```

`cron-job.org` and a GitHub Actions schedule both do this for nothing. Leave
`SCHEDULER_ENABLED` unset on Vercel — setting it starts timers inside a function
that is frozen the moment it returns a response.

### What is different about running here

| | On a VPS | On Vercel |
|---|---|---|
| Storage | local disk volume | S3-compatible bucket, required |
| Scheduler | in-process timers | `/api/cron` plus an external schedule |
| Database | one direct connection | pooled URL, plus a direct one for migrations |
| Login throttling | same table | same table — it lives in Postgres, not memory |
| Backups | `scripts/backup.sh` | your Postgres host's backups, plus the bucket |

The last row is the one to think about before real books go in. On a VPS you own
the backup and the restore is documented below. On Vercel your data is in
someone else's Postgres, so check what their free tier actually retains — and
either way, take the **full data export** from Settings → Company periodically,
because it is the copy that stays readable without this app.

## Backup and restore

Back up the database and the storage volume. The database is the one that
matters.

`scripts/backup.sh` does both and prunes anything older than 30 days:

```bash
./scripts/backup.sh /var/backups/ledger

# From cron, 02:15 daily
15 2 * * * cd /srv/ledger && ./scripts/backup.sh /var/backups/ledger >> /var/log/ledger-backup.log 2>&1
```

A backup on the same machine as the database is not a backup — it dies with the
box. Copy the output somewhere else as a second step.

By hand, if you would rather:

```bash
docker compose -f docker-compose.prod.yml exec -T db pg_dump -U ledger -Fc ledger > ledger-$(date +%F).dump
docker compose -f docker-compose.prod.yml run --rm --no-deps -v "$PWD":/backup app \
  tar czf /backup/storage-$(date +%F).tar.gz -C /data/storage .

# Restore into an empty database.
# Stop the app first: it holds connections to `ledger`, and a database with
# anyone connected to it cannot be dropped. Connect to `postgres` to do the
# dropping — `psql -U ledger` with no -d connects to `ledger` itself, and a
# session cannot drop the database it is sitting in.
C=docker-compose.prod.yml
docker compose -f $C stop app
docker compose -f $C up -d db
docker compose -f $C exec -T db psql -U ledger -d postgres -c 'DROP DATABASE IF EXISTS ledger;'
docker compose -f $C exec -T db psql -U ledger -d postgres -c 'CREATE DATABASE ledger;'
docker compose -f $C exec -T db pg_restore -U ledger -d ledger --clean --if-exists < ledger-2026-08-21.dump
docker compose -f $C run --rm --no-deps -v "$PWD":/backup app \
  tar xzf /backup/storage-2026-08-21.tar.gz -C /data/storage
docker compose -f $C start app
```

Verify a restore before you need one: restore into a scratch database and check
that the Trial Balance matches.

`pg_dump` and the **full data export** in Settings → Company answer different
questions and you want both. The dump restores this app exactly and is
unreadable without it; the export is twenty CSVs any spreadsheet or accountant
can open, and is what you would hand someone if this app disappeared.

## Configuration

Every variable is documented in `.env.example`. The ones that matter:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `TEST_DATABASE_URL` | Separate database for `npm test` |
| `AUTH_SECRET` | Session encryption. `openssl rand -base64 32` |
| `AUTH_URL` | Public URL, required in production |
| `STORAGE_DRIVER` | `local` (default) or `s3` |
| `EMAIL_DRY_RUN` | `true` short-circuits sending and only writes the log |
| `SCHEDULER_ENABLED` | `true` runs the in-process jobs. **Recurring invoices do not generate without it** — set it on exactly one instance |
| `TOKEN_ENCRYPTION_KEY` | Envelope-encrypts stored Gmail refresh tokens. `openssl rand -base64 32` |
| `DIRECT_DATABASE_URL` | Unpooled connection for migrations. Must always be set; same as `DATABASE_URL` on a VPS |
| `CRON_SECRET` | Authorises `/api/cron`. Required wherever the in-process scheduler is off |
| `LEDGER_DOMAIN` | Single-VPS only: the domain Caddy gets a certificate for |
| `POSTGRES_PASSWORD` | Single-VPS only: required, no default |

App login and the Gmail *sending* connection (Phase 7) are separate concerns:
`AUTH_GOOGLE_*` is sign-in, and does not let the app send mail as anyone.

## Conventions worth knowing before you edit

- **Money is `Decimal` or integer minor units. Never a float.** This holds for
  anything parsed out of a spreadsheet cell too.
- **Accounting dates are `DATE`** with no time zone. Event timestamps
  (clock in/out, email sent) are `TIMESTAMPTZ` in UTC.
- **Every query is company-scoped** through `withCompanyScope()`. Hiding a nav
  link is not access control.
- **From Phase 2, one function posts to the ledger** — `postJournalEntry()`.
  Nothing else writes a journal line, bulk operations included.
