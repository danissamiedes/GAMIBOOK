# SPEC.md — Ledger (working name)

A small-business accounting application with consultant time tracking.
This document is the build spec. Read it fully before writing code.

---

## 0. How to use this spec

You are building an MVP from scratch. Follow the phases in §14 in order.
Do not skip the double-entry ledger (§4) — every other feature depends on it.

Where this spec says **MUST**, treat it as a hard requirement with a test.
Where it says **SHOULD**, use judgment but note deviations in `DECISIONS.md`.
Anything not specified here is your call, but favour boring, well-documented
choices over clever ones. This system holds financial records; correctness and
auditability beat elegance.

---

## 1. Problem and goal

The business currently tracks money manually (spreadsheets and memory):

- payments **to consultants** (contractors, mostly based in the Philippines)
- payments **received from clients**
- **other business expenses**

The goal is a self-hosted web application that replaces the manual process and
can produce a **Profit & Loss** and a **Balance Sheet** that are correct in the
same sense QuickBooks' are — i.e. derived from a real general ledger, not
estimated from a list of categorised transactions.

Secondary goals, all in the MVP:

- email consultants their **work orders** (description, quantity, rate),
  individually or **in bulk from a multi-select screen** (§8.4)
- create work orders **in bulk by importing a spreadsheet** (§8.3)
- email clients their **invoices**, including **recurring invoices**
- let consultants **log in and clock in / clock out**, recorded and displayed in
  **Philippine time (Asia/Manila)**

### Non-goals for the MVP

Explicitly out of scope — do not build these, do not design yourself into a
corner that forbids them later:

- online card payment / Stripe checkout on invoices
- automated bank feeds (Plaid etc.) — CSV import only
- payroll tax, 1099/BIR filings, or any statutory reporting
- inventory, purchase orders, fixed-asset depreciation schedules
- a consultant-facing portal beyond the time clock (see §9)
- mobile native apps (the web UI MUST be usable on a phone browser)

---

## 2. Users and roles

Three roles. Roles are assigned **per company** (see §3), not globally.

| Role | Who | Can do |
|---|---|---|
| `OWNER` | Business owner | Everything, including managing users, closing periods, and deleting companies |
| `BOOKKEEPER` | Admin / bookkeeper | Everything financial: customers, consultants, invoices, work orders, expenses, journal entries, reports, imports, bulk email sends. Cannot manage users or delete a company |
| `CONSULTANT` | Contractor | **Only** the time clock: clock in, clock out, and view their own recent time entries **read-only**. They may attach a correction request note to an entry; only an admin can change a recorded time. No access to any financial data, no access to other consultants' entries |

`CONSULTANT` is a deliberately narrow role. A consultant logging in MUST land
directly on the time clock screen and MUST NOT be able to reach any accounting
route — enforce this in middleware **and** at the data-access layer, not only by
hiding nav links.

A single `User` record may hold memberships in several companies with different
roles in each.

**Account lifecycle (required, easy to forget):** an owner/bookkeeper invites a
user by email; the invite carries the role and company and expires in 7 days;
the invitee sets their own password on first use. Plus a self-service password
reset by emailed token. Consultants are the least technical users in the system
and sit behind a login — the invite and reset emails MUST be plain, short, and
work on a phone. These emails go through the same Gmail sender as everything
else (§10), except that if Gmail is not yet connected for the company, invites
fall back to a copyable invite link shown in the UI.

---

## 3. Multi-company model

The system is **multi-company from day one**.

- An `Organization` owns one or more `Company` records.
- Every financial row (account, customer, consultant, invoice, journal entry,
  time entry, import batch, email batch, everything) carries a non-null
  `companyId`.
- The user picks an active company after login; a company switcher sits in the
  top bar. The active company is held in the session, not in a URL param the
  user can tamper with — but every query MUST still filter by `companyId`
  server-side regardless of session state.
- Each company has its **own chart of accounts**, its own numbering sequences,
  its own settings, and its own reports. Nothing is shared across companies
  except `User` accounts.

**MUST:** write a single reusable data-access guard (e.g. a
`withCompanyScope(userId, companyId)` helper or Prisma extension) that all
queries go through. Add a test that proves company A's user cannot read company
B's invoice by ID.

---

## 4. The ledger — this is the core

### 4.1 Chart of accounts

`Account`:

| field | notes |
|---|---|
| `id` | |
| `companyId` | |
| `code` | string, e.g. `1000`. Unique per company. Sorts reports |
| `name` | e.g. "Operating Bank Account" |
| `type` | enum: `ASSET`, `LIABILITY`, `EQUITY`, `INCOME`, `EXPENSE` |
| `subtype` | enum for report grouping: `CASH`, `UNDEPOSITED_FUNDS`, `ACCOUNTS_RECEIVABLE`, `OTHER_CURRENT_ASSET`, `FIXED_ASSET`, `ACCOUNTS_PAYABLE`, `CREDIT_CARD`, `OTHER_CURRENT_LIABILITY`, `LONG_TERM_LIABILITY`, `EQUITY`, `RETAINED_EARNINGS`, `INCOME`, `OTHER_INCOME`, `COST_OF_SALES`, `EXPENSE`, `OTHER_EXPENSE` |
| `parentId` | nullable, for sub-accounts (one level of nesting is enough) |
| `isActive` | soft-disable; never hard-delete an account with postings |
| `isSystem` | true for accounts the app posts to automatically. These cannot be deleted or have their type changed. The full set: Accounts Receivable, Accounts Payable, Retained Earnings, Opening Balance Equity, Undeposited Funds, Sales Tax Payable, Realized FX Gain/Loss, FX Rounding Difference |

Normal balance is derived from `type`: `ASSET` and `EXPENSE` are debit-normal;
`LIABILITY`, `EQUITY`, `INCOME` are credit-normal.

### 4.2 Journal entries

`JournalEntry`:

- `id`, `companyId`, `entryNumber` (sequential per company)
- `date` (a **date**, not a timestamp — accounting dates have no time zone)
- `memo`
- `sourceType` enum: `MANUAL`, `INVOICE`, `INVOICE_PAYMENT`, `WORK_ORDER`,
  `CONSULTANT_PAYMENT`, `EXPENSE`, `BANK_TRANSACTION`, `OPENING_BALANCE`
- `sourceId` (nullable FK to the originating document)
- `postedAt`, `createdByUserId`, `reversedByEntryId` (nullable)

`JournalLine`:

- `id`, `journalEntryId`, `lineNumber`
- `accountId`
- `debit` (decimal 18,2, ≥ 0), `credit` (decimal 18,2, ≥ 0) — exactly one of the
  two is non-zero
- `description`
- `customerId` / `consultantId` / `vendorId` (all nullable) — the "party"
  dimension, required on every A/R and A/P line so aging reports can be built
  from the ledger rather than from document tables. Enforce: a line hitting the
  A/R account MUST carry a `customerId`; a line hitting A/P MUST carry a
  `consultantId` or a `vendorId`
- `currency`, `fxRate`, `foreignAmount` (see §5)

**Hard rules — enforce in code and with a DB constraint or trigger where you can:**

1. Every `JournalEntry` MUST have ≥ 2 lines and `SUM(debit) == SUM(credit)` to
   the cent. Reject the whole entry otherwise.
2. Use **integer minor units or `Decimal`** for money. Never `float`. Never
   JavaScript `number` arithmetic on money.
3. Posted journal entries are **immutable**. To change one, post a reversing
   entry (same lines with debit/credit swapped, dated per the reversal date) and
   then post the corrected entry. Editing a source document (e.g. an invoice)
   MUST reverse-and-repost rather than mutate lines in place.
4. A company has a `booksClosedThrough` date. Posting on or before that date is
   rejected for everyone except `OWNER`.
5. Every posting goes through **one** service function, e.g.
   `postJournalEntry({ companyId, date, memo, sourceType, sourceId, lines })`.
   No other code writes `JournalLine` rows. This is the single most important
   architectural rule in this spec. Bulk operations (§8.3, §8.4) are no
   exception: they loop over this one function, they do not batch-insert lines.

### 4.3 Posting rules

Each document type posts a specific entry. Implement these exactly.

**Customer invoice issued** (accrual, at invoice date):

```
DR  Accounts Receivable        invoice total
    CR  Income account(s)          per line, net of tax
    CR  Sales Tax Payable          if tax applies
```

**Payment received from client:**

```
DR  Bank / Undeposited Funds   amount received, at the PAYMENT's fx rate
    CR  Accounts Receivable        amount applied, at the INVOICE's fx rate
    DR/CR  Realized FX Gain/Loss    the difference, if any
```

**Work order approved** (a payable to a consultant, posted on `approvedAt`):

```
DR  Consultant Cost / COGS     work order total
    CR  Accounts Payable            work order total
```

**Payment made to consultant:**

```
DR  Accounts Payable           amount applied, at the WORK ORDER's fx rate
    CR  Bank                        amount paid, at the PAYMENT's fx rate
    DR/CR  Realized FX Gain/Loss     the difference, if any
```

**Other expense paid directly** (no bill stage):

```
DR  Expense account            amount
    CR  Bank / Credit Card          amount
```

**Vendor bill (expense on credit), then its payment:** same two-step shape as
work orders — bill hits A/P (with `vendorId` on the line), payment clears it at
the bill's fx rate.

**Opening balances:** a single `OPENING_BALANCE` entry per company with the
balancing figure posted to `Opening Balance Equity`.

**Settling a foreign-currency document — the rule that is easiest to get
wrong.** The A/R or A/P leg is relieved at the **historic rate of the document**,
never the payment's rate. That is the whole point: the receivable was recorded
in base currency at issue, and it must be removed at exactly that amount or the
control account never clears to zero. The cash leg uses the payment's rate. The
plug goes to `Realized FX Gain / Loss`. For a **partial** payment, relieve the
control account **pro rata** at the document rate:
`baseRelieved = documentBaseTotal × (foreignAmountApplied / documentForeignTotal)`,
with the final payment on a document taking the rounding residual so the
document's base-currency balance lands exactly on zero. For a payment applied
across several documents (§7.1, §8.1), do this **per document**, producing one
control-account line per document, each at that document's own rate.

**Rounding.** When each line of a foreign-currency document is converted and
rounded to cents independently, the summed line amounts will sometimes miss the
converted document total by a cent or two — and §4.2 rule 1 would then reject
the entry. Required rule: convert the **document total** to base currency as the
authoritative figure, convert lines individually, and post any residual to the
`FX Rounding Difference` account (an `OTHER_EXPENSE` system account) as an extra
line. Never fix it by silently adjusting a revenue or expense line. Test this
with a rate like `0.017234` and seven lines.

**No year-end closing entries.** This system does not post closing journal
entries. Retained earnings are computed dynamically at report time (§12.2).
Nothing ever posts to the Retained Earnings account except a user's manual
opening-balance entry when migrating from a previous system.

Each of these MUST have a unit test asserting the resulting lines and that
debits equal credits.

---

## 5. Currency

The consultants are paid in **Philippine pesos (PHP)**; the business's books may
be kept in a different currency. Handle this generally rather than hardcoding:

- Each `Company` has a `baseCurrency` setting (ISO 4217). **All reports — P&L,
  Balance Sheet, Trial Balance — are presented in the company's base currency
  only.** The GL stores base-currency amounts in `debit` / `credit`.
- A `Customer` or `Consultant` may have a `defaultCurrency` different from the
  base currency. Their documents (invoices, work orders) are entered, displayed,
  and emailed in **their** currency.
- When a foreign-currency document posts, each journal line records
  `foreignAmount` + `currency` + `fxRate`, and `debit` / `credit` hold the
  converted base-currency amount. `fxRate` is entered by the user on the
  document, with the last used rate for that pair pre-filled as the default. Do
  **not** call an external FX API in the MVP.
- On settlement, if the payment's rate differs from the document's rate, the
  difference posts to `Realized FX Gain / Loss`. Do not implement period-end
  revaluation (unrealized FX) in the MVP.

**Note this back to the user:** if the intent is that the *entire* business runs
on PHP — clients invoiced in PHP too — then set `baseCurrency = PHP` at company
setup and the FX path above simply never fires. The design supports both without
change. Flag this in the setup wizard with a clear "this cannot be changed later"
warning, because changing base currency after postings exist is not supported.

Formatting: currency is always displayed with an explicit code (`PHP 12,500.00`,
`USD 250.00`), never a bare symbol, because two currencies coexist on screen.

---

## 6. Customers, consultants, vendors, and items

**Customer:** name, email(s) for invoicing, billing address, default currency,
default payment terms (Net 15/30/etc.), notes, active flag.

**Consultant:** name, default currency (PHP), default rate, default
expense/COGS account, notes, active flag, and an optional link to a `User`
record so they can log in to the time clock. A consultant with no linked user
simply cannot clock in — that's valid.

Consultant email fields, which the bulk send in §8.4 depends on:

| field | notes |
|---|---|
| `email` | primary address, required for an active consultant |
| `workOrderToEmails` | string list. The **recipients used when emailing work orders**. Empty means "use `email`" — do not duplicate the primary address into this field, or changing the primary address silently stops reaching them |
| `workOrderCcEmails` | string list, optional (a manager, an agency contact) |
| `emailOptOut` | boolean. Excluded from bulk sends and shown as excluded, never silently dropped |

The consultant form MUST show the effective recipient list ("Work orders go to:
…") computed from these fields, because bulk sending is only trustworthy if the
user can see, per consultant, where mail will land before selecting 40 of them.

**Vendor:** name, email, default currency, default expense account, notes,
active flag. A real table, not free text — A/P aging (§12.6) needs a party to
group by, and the ledger carries `vendorId` on payable lines (§4.2). Keep the
form to those fields; this is not a procurement system.

**Item / Service** (light): name, description, default rate, default income
account (for invoices) or expense account (for work orders). Used to pre-fill
lines. Keep it simple; this is not inventory.

---

## 7. Money in — client invoicing

### 7.1 Invoice

`Invoice`: `companyId`, `customerId`, `invoiceNumber` (nullable until issue —
see below), `issueDate`, `dueDate` (derived from terms, editable), `currency`,
`fxRate`, `status`, `memo`, `terms`, `subtotal`, `taxTotal`, `total`,
`amountPaid`, `balanceDue`, `lastEmailedAt`.

`InvoiceLine`: `itemId?`, `description`, `quantity`, `rate`, `amount`,
`incomeAccountId`, `taxRateId?`.

**Status machine.** States: `DRAFT`, `ISSUED`, `PARTIALLY_PAID`, `PAID`, `VOID`.
Legal transitions:

```
DRAFT      → ISSUED | (hard delete allowed, drafts are not accounting records)
ISSUED     → PARTIALLY_PAID | PAID | VOID
PARTIALLY_PAID → PAID | ISSUED (all payments removed) | VOID
PAID       → PARTIALLY_PAID (a payment is reversed) | ISSUED (all removed) | VOID
VOID       → (terminal)
```

Note `ISSUED → PAID` directly: a single payment for the full amount is the
common case and must not be forced through `PARTIALLY_PAID`. Status is
**derived** from `balanceDue` for the paid states rather than set by hand —
recompute it after every payment change.

- **Issuing, not emailing, is what posts to the ledger.** `DRAFT → ISSUED`
  allocates the invoice number and posts the journal entry from §4.3. Emailing
  (§7.3) is a separate action that only stamps `lastEmailedAt` and writes an
  `EmailLog` row. Emailing a `DRAFT` is allowed and does **not** post anything —
  but the UI MUST warn that the customer is receiving an unissued invoice and
  offer "Issue and send" as the primary button.
- Only a `DRAFT` invoice can be freely edited. Editing an `ISSUED` invoice
  reverses and reposts (§4.2 rule 3), and is blocked entirely once payments are
  applied — remove the payments first.
- `VOID` posts a full reversal and keeps the number reserved. Voiding a document
  with payments applied is blocked; the payments must be reversed first, so that
  cash never disappears silently. Never delete an invoice that has been issued.
- **Numbering:** `invoiceNumber` is `NULL` on drafts and allocated from the
  per-company sequence inside the same transaction as the `DRAFT → ISSUED`
  transition. This is what makes the sequence gap-free while still letting the
  user throw drafts away. Same rule for work orders (allocated on approval) and
  journal entries (allocated on post).

`Payment` (receipts side): `date`, `amount`, `currency`, `fxRate`,
`depositAccountId`, `method` (`BANK_TRANSFER`, `CHECK`, `CASH`, `WISE`,
`OTHER`), `reference`, `notes`, `customerId` — plus a child
`PaymentApplication` (`paymentId`, `invoiceId`, `amountApplied`) so one payment
can settle several invoices. Model it this way from the start; bolting
many-to-many on later means rewriting the posting code. An over-payment leaves
an unapplied balance on the `Payment` (credit on account) — show it, don't
silently discard it.

**Reversing a payment** posts a reversing journal entry, deletes nothing, and
recomputes `amountPaid` / `balanceDue` / `status` on every invoice it touched.

### 7.2 Recurring invoices

`RecurringInvoiceTemplate`: everything an invoice has, plus:

- `frequency`: `WEEKLY`, `BIWEEKLY`, `MONTHLY`, `QUARTERLY`, `ANNUALLY`
- `dayOfMonth` / `dayOfWeek` as applicable
- `startDate`, `endDate?`, `occurrenceLimit?`
- `nextRunDate`, `lastRunDate`
- `mode`: `AUTO_SEND` | `CREATE_DRAFT` — per template. Default `CREATE_DRAFT`.
  Auto-sending invoices without human review is a real risk; make the user opt in.
- `isPaused`

A scheduled job (node-cron in-process is fine for the MVP, but put the logic in
a plain function so it can move to a queue later) runs daily at 06:00 in the
company's `operatingTimeZone` (a company setting, distinct from the time-clock
zone in §9 — a US company should not invoice on Manila time), generates due
invoices, and either emails them or leaves them as drafts. The job MUST be
idempotent — keyed on `(templateId, scheduledDate)` — so a double-run never
issues two invoices.

Show the user an "Upcoming recurring invoices" list for the next 30 days.

### 7.3 Invoice PDF and email

- Generate a **PDF** for every invoice (see §11).
- Email body: short, plain, configurable per company (a stored template with
  `{{customer_name}}`, `{{invoice_number}}`, `{{total}}`, `{{due_date}}`
  placeholders). PDF attached.
- Sending is via Gmail (§10). Record every send in `EmailLog`.
- A "Resend" action and a visible "last sent" timestamp on the invoice.

---

## 8. Money out — work orders and expenses

### 8.1 Work order (consultant bill)

A **work order** is the document sent to a consultant describing work and what
they'll be paid. It is a payable.

`WorkOrder`: `companyId`, `consultantId`, `workOrderNumber` (null until
approved), `issueDate`, `approvedAt` (**the date the A/P entry posts** — set on
approval, defaults to today, editable by the approver), `dueDate`, `currency`
(usually PHP), `fxRate`, `status`, `memo`, `total`, `amountPaid`, `balanceDue`,
`lastEmailedAt`, `importBatchId?` (§8.3).

`WorkOrderLine`: `description`, `quantity`, `rate`, `amount`, `expenseAccountId`.

> **Description, quantity, and rate are the three fields the user named
> explicitly.** They are the heart of this document — make the line editor fast:
> keyboard-navigable, add-row on Tab from the last field, running total visible.

Status machine: mirrors the invoice machine in §7.1 exactly, with `APPROVED` in
place of `ISSUED` — including the direct `APPROVED → PAID` transition, derived
paid states, number allocation on approval, and the block on editing or voiding
a document that has payments applied.

`APPROVED` is what posts the A/P entry, dated `approvedAt`. **Emailing is
independent of approval** — the user may email a draft work order for the
consultant's confirmation before approving it, and doing so posts nothing.

`Bill` (payables side): one model covering both work-order payments and vendor
bill payments, structurally identical to `Payment` in §7.1 — a `BillPayment`
header (`date`, `amount`, `currency`, `fxRate`, `paymentAccountId`, `method`,
`reference`, `notes`, `consultantId` or `vendorId`) with `BillPaymentApplication`
children pointing at either a `WorkOrder` or an `Expense` recorded as a bill.
One payment can settle several documents; reversal behaves as in §7.1.

**Time entries do not feed work orders.** The user was explicit: the time clock
is attendance tracking, and work orders are created manually (or by spreadsheet
import, §8.3). Do not build an "import hours into work order" flow. (Do put
`consultantId` and a date range on the work order form so a future version
*could* — but no UI for it now.)

### 8.2 Other expenses

`Expense`: `companyId`, `vendorId` (§6), `date`, `kind` (`DIRECT` | `BILL`),
`currency`, `fxRate`, `paymentAccountId` (bank or credit card — required when
`kind = DIRECT`, null when `BILL`), `expenseAccountId`, `amount`, `description`,
`reference`, `receiptFileId?`, `isBillable?`, `customerId?`, `dueDate?`
(bills only), `status`, `amountPaid`, `balanceDue`.

Two shapes, and both need to be fully modelled:

- **`DIRECT`** — paid at the moment it's recorded. Posts `DR Expense / CR Bank`
  and is immediately terminal. `status` is always `PAID`. This is the common
  case and the form's default.
- **`BILL`** — owed and paid later. Posts `DR Expense / CR A/P` with `vendorId`
  on the payable line, and follows the **same status machine as a work order**
  (`DRAFT → OPEN → PARTIALLY_PAID → PAID`, plus `VOID`), cleared by a
  `BillPayment` (§8.1) at the bill's fx rate.

A `DIRECT` expense and a `BILL` are different enough in the UI that they should
be two entry forms sharing one model, not one form with a confusing toggle.

Receipt attachment: store the uploaded file, show a thumbnail, no OCR.

### 8.3 Bulk work order import (Excel)

Entering work orders one at a time does not scale when a month of work is agreed
with a dozen consultants at once. The user MUST be able to upload one
spreadsheet and have the app create many work orders from it.

**Formats.** `.xlsx` and `.csv`. `.xls` (the old binary format) is not required;
reject it with a message telling the user to re-save as `.xlsx`. Multi-sheet
workbooks get a sheet picker, defaulting to the first sheet. Parse
**server-side** with a maintained library (SheetJS `xlsx` or ExcelJS) — never
parse in the browser and trust what it posts back. Limits: 10 MB and 2,000 rows
per upload, enforced before parsing.

**A downloadable template** (`/fixtures/work-order-import-template.xlsx`, also
offered as a button on the import screen) with the expected header row and two
example rows. It is a convenience, not a requirement: the mapping step below
must accept a sheet the user already has.

**Column mapping.** The same mapping UI as the bank import (§8.5), built once
and reused: the app guesses each column from its header, the user corrects it,
and the mapping is **saved per company** and re-offered by name on the next
import. Recognised fields:

| field | required | notes |
|---|---|---|
| Consultant | yes | matched by email, then by exact name, then by a consultant code. Ambiguous or unknown → row error, never a silently created consultant |
| Group key | no | see grouping below |
| Issue date | no | defaults to the import date |
| Due date | no | defaults from the consultant's terms |
| Currency | no | defaults to the consultant's `defaultCurrency` |
| FX rate | no | required when currency ≠ base currency and no last-used rate exists |
| Description | yes | the work order line description |
| Quantity | yes | |
| Rate | yes | defaults to the consultant's default rate if the column is absent entirely, but never row-by-row silently |
| Amount | no | if present it is **checked** against quantity × rate, not trusted; a mismatch over one cent is a row error |
| Expense account | no | account code or name; defaults to the consultant's default expense/COGS account |
| Memo | no | work order memo |

**Grouping rows into documents.** Rows are grouped into one work order per
`(consultantId, currency, issueDate, groupKey)`. With no `Group key` column that
collapses to one work order per consultant per issue date, each spreadsheet row
becoming one work order line — which is the common case. The preview MUST show
the grouping ("12 rows → 5 work orders") before anything is created.

**Parsing rules that will bite you:**

- Money and quantities are parsed to `Decimal` from the cell's **raw value**;
  strip currency symbols, thousands separators, and stray spaces from strings.
  Never `parseFloat`. A cell that does not parse cleanly is a row error.
- Dates: use the library's date coercion (`cellDates`) so Excel serial numbers
  become real dates via the workbook's own date system. A date arriving as a
  bare string is parsed with the **date format the user picked in the mapping
  step**, not a guess — `03/04/2026` is ambiguous and must never be resolved by
  locale luck.
- Blank rows are skipped; a row with some but not all required fields is an
  error, not a skip.

**Staging and preview.** Import is two steps and never one.

`ImportBatch`: `companyId`, `kind` (`WORK_ORDER` | `BANK_TRANSACTION`),
`fileName`, `fileHash`, `fileId` (storage, §13), `mappingId?`, `status`
(`PARSED`, `COMMITTED`, `DISCARDED`), `rowCount`, `createdWorkOrderCount`,
`createdByUserId`, `createdAt`.

`ImportRow`: `importBatchId`, `rowNumber`, `rawJson`, `parsedJson`, `status`
(`VALID`, `ERROR`, `IMPORTED`, `SKIPPED`), `errors` (list of
`{ column, message }`), `workOrderId?`.

The preview screen shows every row with its resolved consultant, computed
amount, and target work order, errors highlighted in place. **Partial commit is
allowed and is the default:** valid rows import, error rows stay in the batch so
the user can fix the sheet and re-submit just those. The commit itself runs in
**one DB transaction** — if it fails, nothing is created.

**Imports create `DRAFT` work orders and post nothing.** Approval is what posts
(§8.1), and approval stays a deliberate act. Bulk-approving an imported batch is
available from §8.4.

**Idempotency.** Store `fileHash` per batch and warn loudly when the same file
is uploaded again for the same company ("this file was imported on 3 Feb,
creating 12 work orders — import anyway?"). Re-importing after that warning is
allowed; the user may genuinely be re-running a corrected sheet.

**Audit.** Each created work order carries `importBatchId`, the batch links back
to the stored original file, and the commit writes one `AuditLog` row for the
batch plus the normal per-document rows.

### 8.4 Bulk work order actions and emailing

A screen for operating on many work orders at once — the other half of the
import above, and the answer to "email this month's work orders to everyone".

**The list.** Work Orders → list view with filters: status, consultant, date
range, currency, import batch, and two email filters that matter in practice —
"never emailed" and "changed since last emailed". Multi-select with a
select-all-matching-the-filter option (which selects the whole filtered set, not
just the visible page, and says how many).

**Bulk actions:** *Email selected*, *Approve selected*, *Download PDFs (zip)*.

**Email — recipient resolution.** For each selected work order, recipients come
from the consultant record (§6): `workOrderToEmails` if set, otherwise `email`,
plus `workOrderCcEmails`. Consultants with no usable address or with
`emailOptOut` are **listed as excluded in the preview and skipped** — never
silently dropped, and never substituted with some other address.

**Grouping.** Default: **one email per consultant**, with every selected work
order for that consultant attached as a separate PDF. A toggle switches to one
email per work order. If a consultant's attachments would exceed 20 MB total,
split into several emails and say so in the preview.

**Preview and confirm.** A table with one row per outgoing email: consultant,
To/Cc addresses, work order numbers (or "DRAFT" where no number is allocated
yet), totals, attachment filenames, and the rendered subject. The selection may
include drafts — emailing them posts nothing (§8.1), but the preview MUST warn
that unapproved work orders are being sent. Sending requires an explicit
"Send N emails" click (§10), and `EMAIL_DRY_RUN` short-circuits it exactly as
for single sends.

**Sending.** Every email goes through the same Gmail queue, throttle, and retry
path as §10 — a bulk send is not allowed its own shortcut. PDFs are rendered at
send time from the current document state (§11), never from a stale cache.

`EmailBatch`: `companyId`, `kind` (`WORK_ORDER`), `status` (`QUEUED`,
`SENDING`, `COMPLETED`, `COMPLETED_WITH_FAILURES`), `totalCount`, `sentCount`,
`failedCount`, `createdByUserId`, `createdAt`, `completedAt`. Each `EmailLog`
row (§10) carries `emailBatchId`.

**After sending:** a batch progress/result screen, live while it runs and
permanent afterwards, listing each email with its status and error. Failures are
individually retryable ("Retry failed"). `lastEmailedAt` on a work order is
stamped **only** when its email actually succeeds — a failed send must leave the
document showing as not sent, or the user will believe a consultant was paid
information they never received.

**Bulk approve** on the same screen approves each selected draft, allocating
numbers and posting the A/P entry per §4.3 through `postJournalEntry`, each
document in its own transaction. One document failing (closed period, missing
account) reports that row as failed and does not abort the rest; the result
screen lists the outcome per document.

### 8.5 CSV bank import

- `BankAccount`: linked to a GL account of subtype `CASH` (or a credit card
  liability account).
- Upload a CSV. Present a **column mapping UI** (date / description /
  amount / debit-credit columns / reference) and let the user save the mapping
  per bank account so subsequent imports are one click. Support both the
  single-signed-amount and separate-debit-credit-column layouts, and let the
  user pick the date format. This is the same mapping component used by §8.3.
- `BankTransaction`: `bankAccountId`, `date`, `description`, `amount`,
  `reference`, `importBatchId`, `status` (`UNMATCHED`, `MATCHED`, `EXCLUDED`),
  `matchedJournalEntryId?`, `dedupeHash`.
- **Deduplicate** on `(bankAccountId, date, amount, description)` hash and warn
  loudly on re-import of an overlapping period rather than silently duplicating.
- Matching screen: for each unmatched transaction, suggest candidates within a
  date and amount tolerance. **Three distinct outcomes — implement all three and
  do not let them overlap, or cash will be double-counted:**
  1. **Link to an existing payment.** The `Payment`/`BillPayment` was already
     recorded in the app; the bank line is just its confirmation. Sets
     `matchedPaymentId`. **Posts nothing** — the journal entry already exists.
  2. **Create a payment against an open document.** The user picks an unpaid
     invoice / work order / bill. This creates the `Payment` (or `BillPayment`)
     and posts the settlement entry from §4.3, then links to it.
  3. **Categorise directly.** No document exists (bank fee, interest, a small
     expense). The user picks an account and this posts `DR/CR account / CR/DR
     bank` on the spot, setting `matchedJournalEntryId`.

  Case 1 is the one implementers skip, and skipping it is what produces
  duplicated cash. Every matched transaction MUST end up pointing at exactly one
  journal entry, whether it created it or found it.
- **Unmatching** must reverse whatever the match created (nothing, in case 1)
  and return the transaction to `UNMATCHED`.
- Show a running "unmatched transactions" count as a badge — this is the daily
  driver of the bookkeeping workflow.

Reconciliation (statement-balance-to-book-balance sign-off) is **not** in the
MVP. Import and match only.

---

## 9. Time tracking (Asia/Manila)

Requirement: consultants log in and record time in and time out; the business
sees it in **Philippine time**.

`TimeEntry`:

- `id`, `companyId`, `consultantId`
- `clockInAt` (UTC timestamp), `clockOutAt` (UTC timestamp, nullable while open)
- `durationMinutes` (computed and stored on clock-out, for reporting)
- `note` (optional, what they worked on)
- `source`: `SELF` | `ADMIN_ENTERED` | `ADMIN_EDITED` | `AUTO_CLOSED`
- `editedByUserId?`, `editReason?`, `originalClockInAt?`, `originalClockOutAt?`
- `correctionRequest?` (free text the consultant can add; raises a flag on the
  admin timesheet but changes nothing on its own), `correctionResolvedAt?`

**Time zone rules — get these right, they are the most common source of bugs:**

- Store **UTC** timestamps in the database, always.
- Render clock times in **`Asia/Manila`** everywhere in the UI, for every user,
  regardless of the viewer's browser locale — with an explicit "PHT" label on
  every displayed time so nobody has to guess.
- The "work day" a `TimeEntry` belongs to is determined by the **Manila calendar
  date of `clockInAt`**, not UTC date. Grouping, daily totals, and date filters
  MUST use Manila dates. Write a test for an entry starting 23:30 PHT and ending
  01:15 PHT the next day.
- Asia/Manila has **no daylight saving time** (fixed UTC+8), which simplifies
  this — but do not hardcode `+8`. Use a real tz library (`date-fns-tz` or
  Luxon) with the IANA zone so the rest of the app is DST-safe.
- There are **two** company time-zone settings and they must not be conflated:
  `timeClockTimeZone` (default `Asia/Manila`) governs everything in this section
  — display, day grouping, timesheet totals. `operatingTimeZone` (default the
  company's own locale) governs scheduled jobs such as recurring invoicing
  (§7.2). The accounting side uses plain dates and is unaffected by both.

**Consultant screen** (the only screen this role sees):

- Big current time in PHT, big **Clock In** / **Clock Out** button
- Current status ("Clocked in since 9:02 AM PHT — 3h 24m elapsed", live-ticking)
- Today's entries and this week's total
- Their own last 30 days, read-only, with a "request correction" note field
- Must work well on a phone

Guards: only one open entry per consultant at a time; block a second clock-in
while one is open. Auto-close an entry left open longer than a configurable
`maxShiftHours` (default 16) and flag it for admin review rather than letting it
run forever.

**Admin screens:**

- Timesheet grid: consultant × day for a chosen week/period, in PHT, with
  totals; click a cell to see and edit the underlying entries
- Manual add/edit of any entry, with an audit trail (`source`, `editedBy`,
  `editReason`, original values retained)
- Export a period to CSV
- Open-entry alert list

---

## 10. Email sending (Gmail / Google Workspace)

Emails are sent **from the user's Google Workspace mailbox** via the Gmail API,
so sent mail appears in their Sent folder and replies come back to them.

- OAuth 2.0 with `https://www.googleapis.com/auth/gmail.send` — request the
  narrowest scope that works; do not request read scopes.
- Store refresh tokens **encrypted at rest** (envelope encryption with a key
  from the environment, not plaintext in the DB).
- Connection is per company: Settings → Email → "Connect Google account", shows
  the connected address and a Disconnect button. Handle token expiry/revocation
  with a clear "reconnect required" banner rather than silent failures.
- Respect Gmail's sending limits (Workspace: ~2,000 recipients/day; consumer:
  ~500). Queue sends, throttle, retry with backoff on 429/5xx, and surface a
  clear error to the user on hard failure. **Bulk work-order sends (§8.4) are
  the main way a user will hit these limits** — the queue MUST be shared, the
  throttle MUST apply per company across all senders, and a bulk send that would
  exceed the daily quota must be paused with a clear message and resumable,
  not silently truncated.
- **`EmailLog`** for every attempt: `companyId`, `toAddresses`, `cc`, `subject`,
  `bodySnapshot`, `attachmentNames`, `relatedType`/`relatedId`,
  `emailBatchId?` (§8.4), `status` (`QUEUED`, `SENT`, `FAILED`),
  `gmailMessageId`, `error`, `sentAt`, `sentByUserId`. Show this log in the UI,
  filterable by document and by batch.
- Templates per company, editable in Settings, with a live preview and a "send
  test to myself" button: `INVOICE`, `INVOICE_REMINDER`, `WORK_ORDER`,
  `PAYMENT_RECEIPT`. The `WORK_ORDER` template supports
  `{{consultant_name}}`, `{{work_order_number}}`, `{{total}}`, `{{due_date}}`,
  and — for the grouped bulk send — `{{work_order_count}}` and
  `{{work_order_list}}`.
- **Every email screen MUST show a preview and require an explicit Send click**,
  except recurring templates set to `AUTO_SEND`. This applies to bulk sends too:
  the preview lists every outgoing email before anything leaves. In development,
  a `EMAIL_DRY_RUN=true` env var MUST short-circuit actual sending and just write
  the log — do not send real email from a dev machine.

---

## 11. PDF generation

- Server-side rendering of an HTML template to PDF (Puppeteer/Playwright, or
  React-PDF — your call; pick one and stay consistent).
- Documents: **Invoice**, **Work Order**, and **Payment Receipt**.
- Company branding in Settings: logo upload, company name, address, email,
  phone, tax/registration number, footer text (payment instructions,
  bank details). These appear on all three documents.
- Filenames: `Invoice-{number}-{customer-slug}.pdf`,
  `WorkOrder-{number}-{consultant-slug}.pdf`. A work order with no number yet
  (a draft being emailed for confirmation) uses
  `WorkOrder-DRAFT-{id-short}-{consultant-slug}.pdf`, so bulk attachments never
  collide.
- The PDF must be downloadable from the document screen as well as attachable to
  email, and generated in bulk for §8.4 (attachments and the zip download).
  Bulk generation MUST be bounded — render with a small concurrency limit and a
  per-render timeout, because a browser-based renderer will happily exhaust the
  box if you hand it 200 documents at once.

---

## 12. Reports

All reports: date-range or as-of-date picker with presets (This Month, Last
Month, This Quarter, This Year, Last Year, Custom), a company header block, and
**CSV export** (PDF export is added for all reports once the renderer exists in
Phase 7 — reports built before then ship with CSV and a print stylesheet).
Every figure in every report MUST be **drillable** — click
an amount to see the journal lines behind it, click a line to open the source
document. This is the feature that makes the system trustworthy.

1. **Profit & Loss** — Income, Cost of Sales, Gross Profit, Expenses, Other
   Income/Expense, Net Income. Accrual basis is the default and is required;
   cash basis is a `SHOULD`, added as a toggle if time allows. Optional
   comparison column (prior period or prior year) and % of income column.
2. **Balance Sheet** — Assets (current, then fixed), Liabilities (current, then
   long-term), Equity, as of a chosen date.

   **Equity is where balance sheets go wrong. The exact rule, because the system
   posts no closing entries (§4.3):**
   - Let `FY` be the fiscal year **containing the as-of date** — not the current
     calendar year, or every historical balance sheet is wrong.
   - **Net Income (current year)** = income − expenses for postings dated from
     `FY.start` through the as-of date.
   - **Retained Earnings** = the Retained Earnings account's own balance
     (from migration/opening entries only) **plus** income − expenses for **all
     postings dated before `FY.start`**, back to the beginning of time.
   - **Equity** = contributed capital and other equity accounts + Opening
     Balance Equity + Retained Earnings (as computed above) + Net Income
     (current year).

   Computing retained earnings from the account balance alone would silently
   drop every prior year's profit from the second fiscal year onward — and the
   seed data only spans three months, so no test will catch it unless you write
   one that spans a fiscal-year boundary. Write that test.

   The report MUST assert `Assets == Liabilities + Equity` to the cent and
   display a loud error banner if it doesn't, rather than quietly showing a
   wrong number.
3. **Trial Balance** — every account with debit and credit columns and totals
   that match. Your first debugging tool; build it early.
4. **General Ledger / Account detail** — running balance per account for a period.
5. **A/R Aging** — per customer: current, 1–30, 31–60, 61–90, 90+.
6. **A/P Aging** — same, per consultant/vendor.
7. **Time report** — hours per consultant per day/week/period in PHT.

Fiscal year start month is a company setting (default January).

**Dashboard** (landing page for OWNER/BOOKKEEPER): cash balances, income vs
expenses for the last 6 months, A/R outstanding and overdue, A/P outstanding,
unmatched bank transactions count, consultants currently clocked in, and
approved-but-never-emailed work orders (the queue that feeds §8.4). Built in
Phase 9, because its last tiles depend on Phases 6, 7 and 8.

Note that the Trial Balance (Phase 2) initially ships without drill-down; the
drill-down layer is built once in Phase 5 and applied to every report including
the Trial Balance.

---

## 13. Technical requirements

### Stack

Unless you have a strong reason otherwise:

- **Next.js (App Router) + TypeScript**, React Server Components where sensible
- **PostgreSQL** + **Prisma**
- **Tailwind CSS** + **shadcn/ui**
- **Auth.js (NextAuth)** with email+password (Argon2id or bcrypt) and Google
  sign-in. Note: app login and the Gmail *sending* connection are separate
  concerns — don't conflate them.
- **Zod** for validation at every API boundary
- **SheetJS (`xlsx`) or ExcelJS** for spreadsheet parsing (§8.3), server-side
  only, plus a CSV parser for the bank import (§8.5)
- **Vitest** for unit tests, **Playwright** for a handful of end-to-end flows
- Deployable to a single VPS via `docker compose` (app + Postgres). A
  Vercel + hosted-Postgres path is a `SHOULD`, not a `MUST` — note in the README
  that it requires S3-compatible object storage and an external PDF service,
  since Vercel's filesystem is ephemeral and headless Chrome does not fit its
  default runtime.

### File storage

Receipts, company logos, uploaded import files, and generated PDFs need
somewhere to live. Put every read and write behind a small `StorageAdapter`
interface with two implementations: `LocalDiskAdapter` (default, a mounted
volume in the compose file) and `S3Adapter` (any S3-compatible bucket), chosen
by env var. No code outside the adapter touches a file path. This is ten minutes
of work now and is the difference between the two deployment paths above being
possible or not.

Generated PDFs are **cached, not authoritative** — they must be regenerable from
the document at any time, so a lost storage volume never loses financial data.
Uploaded import files are **kept** for audit (an import batch must be able to
show the original sheet), so they are not disposable in the same way.

### Non-negotiables

- **Money:** `Decimal` (Prisma `Decimal` / `decimal.js`) or integer minor units.
  Never floats. A lint rule or code review note enforcing this is welcome. This
  includes anything parsed out of a spreadsheet cell (§8.3).
- **Dates:** accounting dates are `DATE` columns with no time zone. Event
  timestamps (clock in/out, email sent) are `TIMESTAMPTZ` in UTC.
- **Audit log:** an append-only `AuditLog` of who changed what and when for
  every financial document, every import batch and email batch, and every
  user/role change.
- **Bulk operations report per-row outcomes.** Any import, bulk approve, or bulk
  send MUST end on a result screen listing what succeeded and what failed, with
  the error per row, and MUST allow retrying just the failures. Partial success
  is a normal outcome and must never be presented as complete success.
- **Soft delete** for master data (customers, consultants, accounts). Hard
  delete is forbidden for anything referenced by a journal line.
- **Sequences:** invoice/work-order/journal numbers are gap-free per company and
  allocated inside the same transaction as the document, safe under concurrency
  — including when a bulk approval allocates fifty of them at once.
- **Backups:** a documented `pg_dump` command in the README and a "download a
  full data export (CSV bundle)" button in Settings. The user must never feel
  their books are trapped in this app.
- **Security:** rate-limit login, HTTP-only session cookies, CSRF protection on
  mutations, no secrets in the repo, `.env.example` committed with every
  variable documented. Uploaded files are size- and type-checked before parsing,
  and are never served back from a path the user controls.
- **Errors:** never swallow a posting error. If a journal entry fails to
  balance, roll back the whole document operation in one DB transaction.

### Seed data

`npm run seed` MUST create: one organization, two companies (one with
`baseCurrency = USD`, one with `PHP`, to exercise the FX path), a standard chart
of accounts for each, an owner user, a bookkeeper user, three consultants (two
with logins, one with a `workOrderToEmails` list that differs from its primary
`email`, one with `emailOptOut`), four customers, three vendors, ~60 invoices
and work orders in mixed statuses, ~80 expenses of both kinds, a month of time
entries, and in `/fixtures`: a sample bank CSV, a work-order import template
(`work-order-import-template.xlsx`), and a filled sample import sheet with a
deliberate bad row. Print the seeded login credentials at the end.

**The seeded transactions MUST span a fiscal-year boundary** — roughly 18 months
of history, not three — so that the retained-earnings roll-forward (§12.2) is
actually exercised. Include at least one PHP work order in the USD company, one
partial payment, one payment applied across two invoices, one voided invoice,
one time entry that crosses midnight Manila time, and one committed work-order
import batch whose work orders are still `DRAFT` and unemailed. The seed is the
test fixture for the trickiest rules in this spec; treat it that way.

---

## 14. Build phases

Ship each phase working and tested before starting the next.

**Phase 1 — Foundation.** Project scaffold, Postgres + Prisma, auth, user
invites and password reset, Organization/Company/User/Membership, company setup
wizard (base currency, fiscal year, time zones), company switcher, role
middleware, storage adapter, layout and nav, audit log, seed script skeleton.
Test: a user in company A cannot read company B's data.

**Phase 2 — The ledger.** Account model + chart-of-accounts CRUD + default CoA
template, `JournalEntry`/`JournalLine`, the single `postJournalEntry` service,
manual journal entries, opening balances, and the **Trial Balance** report.
Test: unbalanced entries are rejected; trial balance totals match.

**Phase 3 — Money in.** Customers, items, invoices with the full status machine,
payments with applications (one-to-many), payment reversal, A/R aging. Test:
every posting rule in §4.3 for the receivables side.

**Phase 4 — Money out.** Consultants (including the work-order email recipient
fields, §6), vendors, work orders (description/quantity/rate), bill payments,
expenses (both `DIRECT` and `BILL`), A/P aging. Test: payables posting rules; FX
gain/loss on a PHP work order settled at a different rate; the line-rounding
residual case.

**Phase 5 — Reports.** P&L and Balance Sheet, GL detail, the drill-down layer
applied across all reports including the Trial Balance, CSV export and print
stylesheet. Test: `Assets == Liabilities + Equity` on the seeded data; P&L net
income ties to the balance sheet's current-year earnings; a balance sheet dated
in a **prior** fiscal year still balances and shows prior profit in retained
earnings.

**Phase 6 — Time tracking.** Consultant login, clock in/out, PHT rendering,
admin timesheet grid, edits with audit trail, time report, CSV export, and the
job scheduler (introduced here for the stale-shift auto-close, reused in Phase
8). Test: the cross-midnight PHT case; the one-open-entry guard.

**Phase 7 — Documents and email.** PDF renderer, invoice / work order / receipt
templates, company branding, PDF export wired into the reports from Phase 5,
Gmail OAuth, email templates and previews, `EmailLog`, send from invoice and
work order, and the **bulk work-order screen (§8.4)**: multi-select, recipient
resolution, preview, `EmailBatch` queueing, per-email result and retry, bulk
approve, zip download. Test: dry-run mode logs without sending; a bulk send of
five work orders across three consultants produces three emails with the right
attachments; a consultant with no address is reported as excluded rather than
skipped; a failed send leaves `lastEmailedAt` untouched.

**Phase 8 — Imports and recurring.** Recurring invoice templates on the Phase 6
scheduler, upcoming list; the shared column-mapping and staging UI, used by both
the **Excel work-order import (§8.3)** and the **CSV bank import (§8.5)** with
saved mappings, dedupe, and the matching screen with all three match outcomes.
Test: scheduler idempotency; re-importing the same CSV creates zero duplicates;
linking a bank line to an already-recorded payment posts nothing; a 40-row
work-order sheet across eight consultants creates eight draft work orders with
correct line totals and posts **nothing** to the ledger; a sheet with three bad
rows imports the rest and reports those three.

**Phase 9 — Dashboard and polish.** Dashboard, mobile pass on the time clock,
empty states, keyboard shortcuts in line editors, full data export, README with
deployment and backup instructions, `DECISIONS.md`.

---

## 15. Acceptance criteria

The MVP is done when all of these pass, demonstrated against seeded data:

1. Two companies exist with separate books; switching companies changes every
   figure on screen, and cross-company access is impossible by direct URL.
2. A customer invoice can be created, previewed as PDF, emailed via Gmail, part-
   paid, then fully paid — and A/R on the Balance Sheet moves correctly at each
   step.
3. A work order with description/quantity/rate lines can be created, emailed to
   a consultant, approved, and paid — and A/P moves correctly at each step.
4. An expense can be recorded and appears in the P&L in the right period.
5. **The Balance Sheet balances**, and its current-year earnings figure equals
   the P&L net income for the same fiscal year to date. It also balances when
   dated inside a *prior* fiscal year, with that year's profit appearing in
   retained earnings on a later-dated report.
6. Every number on the P&L and Balance Sheet drills through to journal lines and
   then to source documents.
7. A consultant logs in, sees only the time clock, clocks in and out, and the
   admin sees those times in PHT on the timesheet grid — including an entry that
   crosses midnight Manila time.
8. A recurring monthly invoice template generates its invoice on schedule, once
   and only once, even if the job runs twice.
9. A bank CSV imports, maps columns, and dedupes on re-import. A transaction can
   be **linked** to an already-recorded payment without posting anything new,
   **and** separately can create a payment against an open invoice — cash is
   counted exactly once either way.
10. A PHP-denominated work order in a USD-base company posts converted amounts to
    the GL; settling it at a different rate books an FX gain or loss and leaves
    the A/P control account at exactly zero for that document; and a partial
    payment relieves A/P pro rata at the document's rate.
11. **An Excel sheet of work-order rows imports:** columns are mapped and the
    mapping is saved for reuse, rows are grouped into one draft work order per
    consultant, invalid rows are reported per row without blocking the valid
    ones, the Trial Balance is unchanged by the import, and approving the batch
    is what posts A/P.
12. **Several work orders can be selected from a list and emailed in one
    action:** each consultant receives their work order PDF(s) at the address
    configured on their record, `EmailLog` shows one row per email under a
    single `EmailBatch`, `lastEmailedAt` is stamped only on success, excluded
    consultants are listed, and failed sends can be retried without re-sending
    the successful ones.
13. `npm run seed && npm test && npm run build` all succeed from a clean clone.
14. The README explains local setup, deployment, backup, and restore.

---

## 16. Open questions for the user

Do not block on these — pick the noted default, implement it, and list the
question in `DECISIONS.md` for confirmation.

1. **Base currency — the one real open question.** The user said consultants are
   paid in **PHP**. It is not yet confirmed whether *clients* are also invoiced
   in PHP (so the whole business runs on PHP and no FX ever occurs) or whether
   the books are kept in USD with PHP only on the consultant side (so the FX
   path in §5 is live from day one). The design handles both; the setup wizard
   forces the choice per company. Build and test **both** paths — the seed data
   requires it — and confirm with the user before the first real company is set
   up, because base currency cannot be changed after postings exist.
2. **Sales tax / VAT.** Is tax charged on client invoices (US sales tax,
   Philippine VAT, none)? Default: build a simple per-line `TaxRate` (name, %,
   liability account) that can be left unused.
3. **Consultant classification.** Contractors, so no payroll withholding
   assumed. Default: treat all consultant payments as contractor expense, no tax
   withholding fields.
4. **Existing data.** Is there a spreadsheet of history to migrate, and from
   what date should the books start? Default: opening balances entered manually
   as of a user-chosen start date.
5. **Fiscal year.** Default: January start.
6. **Approval flow.** Does anyone other than the creator need to approve a work
   order before it's emailed or paid? Default: no separate approver — and the
   bulk approve in §8.4 assumes this. If an approver is required later, it
   becomes a status between `DRAFT` and `APPROVED`, not a change to posting.
7. **Work-order import sheet shape.** Is there an existing spreadsheet layout the
   work comes in, and does one row mean one work order or one line of a larger
   one? Default: accept any layout via the mapping step, ship a template for
   users who have no sheet yet, and group rows into one work order per
   consultant per issue date (§8.3) with an optional `Group key` column to
   override.
8. **Bulk email grouping.** Default: one email per consultant with all their
   selected work orders attached, toggleable to one email per work order.
   Confirm which the user expects as the norm.
9. **Emailing unapproved work orders in bulk.** Allowed, with a warning, because
   §8.1 already allows emailing a draft for confirmation. If the user would
   rather bulk send be approved-only, it becomes a filter default, not a rule
   change.
