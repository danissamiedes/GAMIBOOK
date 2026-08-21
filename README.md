# Ledger

Small-business accounting with consultant time tracking. Built to `SPEC.md`;
decisions and deviations are recorded in `DECISIONS.md`.

The point of this system is a real double-entry general ledger — a Profit &
Loss and a Balance Sheet that are correct in the same sense QuickBooks' are,
not estimated from a list of categorised transactions.

## Status

**Phase 1 (Foundation) is complete.** What works today:

- Multi-company data model — Organization → Company → Membership, roles per
  company (`OWNER`, `BOOKKEEPER`, `CONSULTANT`)
- `withCompanyScope()` — the single data-access guard every query goes through
- Auth.js sign-in with Argon2id passwords, rate-limited; optional Google sign-in
- Invitations (7-day expiry) and self-service password reset, both setting the
  password on first use
- Company setup wizard: base currency (permanent), fiscal year, both time zones
- Company switcher, role middleware, append-only audit log
- Storage adapter with local-disk and S3 implementations
- Seed script and the Phase 1 test: a user in company A cannot read company B

Phases 2–9 (ledger, invoicing, work orders, reports, time clock, PDFs and
email, imports, dashboard) are specified in `SPEC.md` §14 and not yet built.

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

Tests run against `TEST_DATABASE_URL`, never the development database, and
migrate it automatically before the first test file.

## Deployment (single VPS)

```bash
cp .env.example .env          # set AUTH_SECRET, POSTGRES_PASSWORD, AUTH_URL
docker compose up -d --build
```

The app container applies migrations on boot, then serves on port 3000. Put a
TLS-terminating reverse proxy (Caddy, nginx) in front of it — session cookies
are marked `Secure` in production, so sign-in will not work over plain HTTP on
a real domain.

Two volumes hold state:

- `db-data` — Postgres. **This is the books.**
- `storage-data` — receipts, logos, uploaded import files, cached PDFs.
  Generated PDFs are regenerable; receipts and import files are not.

A Vercel deployment is possible but needs S3-compatible storage
(`STORAGE_DRIVER=s3`) and, from Phase 7, an external PDF service — Vercel's
filesystem is ephemeral and headless Chrome does not fit its default runtime.

## Backup and restore

Back up the database and the storage volume. The database is the one that
matters.

```bash
# Backup — run daily from cron and keep the output off this machine
docker compose exec -T db pg_dump -U ledger -Fc ledger > ledger-$(date +%F).dump
docker run --rm -v ledger_storage-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/storage-$(date +%F).tar.gz -C /data .

# Restore into an empty database
docker compose up -d db
docker compose exec -T db psql -U ledger -c 'DROP DATABASE IF EXISTS ledger;'
docker compose exec -T db psql -U ledger -c 'CREATE DATABASE ledger;'
docker compose exec -T db pg_restore -U ledger -d ledger --clean --if-exists < ledger-2026-08-21.dump
docker run --rm -v ledger_storage-data:/data -v "$PWD":/backup alpine \
  tar xzf /backup/storage-2026-08-21.tar.gz -C /data
```

Verify a restore before you need one: restore into a scratch database and check
that the Trial Balance matches.

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
