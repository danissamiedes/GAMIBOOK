# Deploying to Vercel — a checklist

The reasoning behind each of these is in README.md under **Deployment (Vercel)**.
This is the short version: the values, in order, with the mistakes that cost the
most time called out where they happen.

Three services, all free tier: **Supabase** (database and file storage),
**GitHub** (the repository and the scheduler), **Vercel** (the app).

## 1. Supabase

Create a project. Pick the region closest to the people using it — every page
load makes several database round trips, so distance is felt.

**Two connection strings**, from Connect → ORMs → Prisma, or from
Project Settings → Database:

| Value | Where from |
|---|---|
| `DATABASE_URL` | **Session pooler**, port **5432** — add `?connection_limit=1` |
| `DIRECT_DATABASE_URL` | the same string, without `connection_limit` |

**Not the transaction pooler on 6543**, though that is the usual advice for
Next.js on serverless. Every posting path in this app runs inside a Prisma
*interactive* transaction, and a transaction-mode pooler does not hold one
server connection for the life of a transaction. Reads work; posting fails
intermittently. `connection_limit=1` is what keeps session mode safe on
serverless — one connection per instance rather than a pool each.

Not the **Direct connection** either: Supabase serves it over IPv6 only without
the paid IPv4 add-on, and GitHub Actions runners have no IPv6, so the nightly
backup would fail every night.

Both strings arrive containing a literal `[YOUR-PASSWORD]`. Replace it, brackets
and all, with the database password from when you created the project.

**Two buckets**, both private: `ledger-files` for the app, `ledger-backups` for
the nightly dump. Then Storage → S3 access keys → new key. Copy the endpoint and
region from that page rather than constructing them — Supabase has used more
than one hostname form.

## 2. Secrets

Generate three separate values on your own machine. A key that has been in a
chat window or a shared document is not a secret any more.

```bash
openssl rand -base64 32   # AUTH_SECRET
openssl rand -base64 32   # TOKEN_ENCRYPTION_KEY
openssl rand -base64 32   # CRON_SECRET
```

Save all three somewhere durable before pasting them anywhere. Vercel's
"Sensitive" toggle means the value can never be read back, only overwritten —
and `CRON_SECRET` has to be typed into GitHub as well.

## 3. Vercel

Import the repository. Framework preset **Next.js**, root directory `./`.

**Build Command: `npm run vercel-build`.** Type it in rather than leaving the
default. That script runs `prisma generate && prisma migrate deploy && next
build`, so the schema is created as part of the deploy. Without it the app comes
up against a database with no tables, and every sign-in returns *"There was a
problem with the server configuration"* — Auth.js's generic error, which means
either `AUTH_SECRET` is missing or `authorize()` threw. Leave Output Directory
and Install Command blank.

**Production Branch** (Settings → Git) must be the branch you actually push.
Vercel defaults it to `main`; if that branch does not exist, every push builds
as a Preview and Production stays permanently empty.

### Environment variables

| Key | Value |
|---|---|
| `DATABASE_URL` | session pooler, 5432, `?connection_limit=1` |
| `DIRECT_DATABASE_URL` | the same, without `connection_limit` |
| `AUTH_SECRET` | generated |
| `TOKEN_ENCRYPTION_KEY` | generated |
| `CRON_SECRET` | generated |
| `STORAGE_DRIVER` | `s3` |
| `S3_BUCKET` | `ledger-files` |
| `S3_ENDPOINT` | from Supabase Storage settings |
| `S3_REGION` | the project's region |
| `S3_ACCESS_KEY_ID` | Supabase S3 access key |
| `S3_SECRET_ACCESS_KEY` | its secret |
| `S3_FORCE_PATH_STYLE` | `true` |
| `EMAIL_DRY_RUN` | `true` until Gmail is connected |

Vercel pre-fills these from `.env.example`, where every value is a placeholder
or a localhost address. Do not accept them as they are.

**Delete** `TEST_DATABASE_URL`, `LEDGER_DOMAIN`, `POSTGRES_PASSWORD` and
`STORAGE_LOCAL_PATH` — none apply here. **Delete `SCHEDULER_ENABLED` too**, and
this one matters: setting it starts timers inside a function that is frozen the
moment it returns a response, so the jobs never fire and nothing says so.

**Leave `AUTH_URL` empty** for now — you do not know the URL until the first
deploy. Set it afterwards and redeploy. Environment variable changes never apply
to an already-built deployment.

## 4. Match the function region to the database

**Settings → Functions → Function Region**, set to your Supabase project's
region — `Singapore (sin1)` for `ap-southeast-1`. Vercel defaults to a US
region, and a posting makes a couple of dozen round trips inside one database
transaction: across regions that is five seconds of network, past Prisma's
transaction ceiling, and the posting is killed with `P2028` having saved
nothing. Reads look fine throughout, so the app seems healthy until you record
something.

## 5. Deploy

Vercel builds on push, and does **not** retroactively build what was already in
the repository when you connected it. If the Deployments list is empty, that is
usually why: push any commit.

## 6. Create the first owner

There is no signup page — you get in by invitation, so someone has to exist
first. Never run `npm run seed` against real books; that is the development
fixture, with demo companies and a shared password.

```bash
DATABASE_URL="<session pooler string, port 5432>" npm run bootstrap
```

The session pooler: bootstrap runs in a transaction, which the transaction
pooler on 6543 will not hold.

Then sign in, and you land on the setup wizard where the permanent base-currency
choice is made.

## 7. The two GitHub workflows

Settings → Secrets and variables → Actions.

For `.github/workflows/scheduled-jobs.yml` — hourly, and the keep-alive that
stops a free Supabase project pausing after a week of no connections:

| Secret | Value |
|---|---|
| `LEDGER_URL` | `https://your-project.vercel.app`, no trailing slash |
| `CRON_SECRET` | the same value as in Vercel |

For `.github/workflows/backup.yml` — nightly, because Supabase's free plan takes
no downloadable automated backup:

| Secret | Value |
|---|---|
| `SUPABASE_DB_URL` | session pooler string, port 5432 |
| `SUPABASE_S3_ENDPOINT` | as above |
| `SUPABASE_S3_REGION` | as above |
| `SUPABASE_S3_ACCESS_KEY_ID` | as above |
| `SUPABASE_S3_SECRET_ACCESS_KEY` | as above |
| `BACKUP_BUCKET` | `ledger-backups` |

Run each once by hand from the Actions tab. A mismatched `CRON_SECRET` returns
401 and fails the workflow loudly, which is much better than discovering months
later that nothing has been running.

## What this deployment cannot do

- **Uploads are capped at 4 MB**, not 10. Vercel rejects a larger request body
  before any of this code runs, so the import screens lower their own limit to
  match. Split larger statements.
- **Downloads share that ceiling.** A full data export of several years could
  exceed it; take that one from a local copy restored from a backup.
- **The scheduler is only as punctual as its cron.** Actions schedules run late
  under load.
- **Emailing invoices needs a Google Cloud OAuth client** — see
  `docs/gmail-setup.md`. Until then `EMAIL_DRY_RUN=true` records what would have
  been sent rather than failing.

## When it breaks

Vercel dashboard → the deployment → **Build Logs** for a failed build, or
**Runtime Logs** for an error after it is live. The build log names the variable.

The two failures worth predicting: `DIRECT_DATABASE_URL` still containing
`[YOUR-PASSWORD]`, and both database URLs pointing at the same port.
