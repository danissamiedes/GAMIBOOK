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

- email consultants their **work orders** (description, quantity, rate)
- create **many work orders at once by importing an Excel file**, rather than
  keying them in one at a time
- **select many work orders and email them in one action**, each going to its
  own consultant's configured recipients with its own PDF attached
- email clients their **invoices**, including **recurring invoices**
- **migrate the existing spreadsheet history** (§4.4) so the P&L and Balance
  Sheet cover prior periods, not just business done inside this app
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
| `BOOKKEEPER` | Admin / bookkeeper | Everything financial: customers, consultants, invoices, work orders, expenses, journal entries, reports, email sending. Cannot manage users or delete a company |
| `CONSULTANT` | Contractor | **Only** the time clock: clock in, clock out, and view their own recent time entries **read-only**. They may attach a correction request note to an entry; only an admin can change a recorded time. No access to any financial data, no access to other consultants' entries |

`CONSULTANT` is a deliberately narrow role. A consultant logging in MUST land
directly on the time clock screen and MUST NOT be able to reach any accounting
route — enforce this in middleware **and** at the data-access layer, not only by
hiding nav links.

### 2.1 Sections — the second axis of access

The role says *how much* someone can do; a **section** says *which part of the
business* they can see. The two are independent, and both are checked.

| Section | Covers |
|---|---|
| `SALES` | Customers, sales orders, invoices, customer payments, sales reports, A/R aging |
| `CONSULTANTS` | Consultant records, work orders, consultant bills, payments to consultants, the consultant side of A/P aging |
| `VENDORS` | Regular vendors, their bills, marking bills paid, direct expenses and receipts, the vendor side of A/P aging |
| `BANKING` | Bank accounts, CSV import, the matching screen |
| `REPORTS` | P&L, Balance Sheet, Trial Balance, General Ledger |
| `SETTINGS` | Chart of accounts, company settings, email settings, templates |

Rules:

- Sections are granted **per membership**, so the same person can hold
  different sections in different companies.
- `OWNER` implicitly holds every section and cannot have them removed — someone
  must be able to see the whole business.
- A `BOOKKEEPER` holds whichever sections the owner grants. A bookkeeper with
  only `VENDORS` records bills and expenses and **cannot see sales figures or
  consultant information at all** — not the screens, not the reports, not by
  typing a URL.
- `CONSULTANT` holds no sections. The time clock is not a section; it is that
  role's only screen.
- **MUST** enforce sections in three places: the navigation (what is offered),
  the route guard (what a URL reaches), and the data-access layer (what a query
  returns). The first two are convenience; the third is the guarantee. A test
  MUST prove a `VENDORS`-only user cannot read an invoice, a customer, or a
  consultant's rate by direct ID.
- A user who reaches a section they do not hold gets a plain "you do not have
  access to this section" page, not a 500 and not a redirect loop.

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
  time entry, everything) carries a non-null `companyId`.
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
  `CONSULTANT_PAYMENT`, `EXPENSE`, `BANK_TRANSACTION`, `OPENING_BALANCE`,
  `MIGRATION` (§4.4)
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
   architectural rule in this spec.

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
DR  Line account(s)            per line, at the line amount
    CR  Accounts Payable            work order net total
```

Each line carries its own account (§8.1), so one work order may debit
Consultant Fees on one line and Supplies Expense on another. **A negative line
— a cash advance being recovered, a deduction — posts as a credit to its own
account**, not as a negative debit, and A/P is credited with the net total. The
net total MUST be greater than zero: a work order that nets to zero or below is
not a payable and is rejected (§8.3), because the consultant would owe the
business money and that is a receivable, not a bill.

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

### 4.4 Historical migration

> **Not built — revised 2026-08-21.** The user confirmed there is no history to
> bring in, so the books start from opening balances at a chosen date and this
> section is not implemented. It is kept as the design to follow if history ever
> needs migrating; nothing below has been written.

The original decision was that the books do not start empty, with spreadsheet
history to bring in, so prior periods would have to appear in the P&L and in
retained earnings — opening balances alone not being enough.

Treat migration as a one-off, reviewable import that goes through
`postJournalEntry` like every other posting. No direct `JournalLine` writes, no
special-case tables, no exemption from §4.2.

Three layers, in this order:

1. **Open items become real documents.** Every unpaid customer invoice and
   unpaid work order or bill as of the migration date is created as a proper
   `ISSUED` / `APPROVED` document dated its real date, so A/R and A/P aging,
   payment application, and FX settlement all behave normally afterwards. This
   is the layer that matters most — a summarised A/R balance cannot be paid off.
2. **Closed periods become summarised journal entries.** For months already
   fully settled, post one `MIGRATION` entry per month per company summarising
   income and expense by account, dated the last day of that month. That gives
   the P&L real prior periods and makes the retained-earnings roll-forward
   (§12.2) correct, without re-keying every historical transaction. Where the
   source data is detailed enough and the user wants the detail, individual
   entries are fine too — the choice is per period, not global.
3. **Opening balances** for balance-sheet accounts as of the earliest migrated
   date, through the single `OPENING_BALANCE` entry (§4.3), balancing to
   Opening Balance Equity.

Rules:

- Same flow as §8.3: upload → parse → validation report → user confirms →
  commit, with the commit in one transaction and an annotated reject file.
- The migration is recorded as an `ImportBatch` with `kind = MIGRATION`, so it
  can be reviewed as a group and — before anything new is posted on top of it —
  rolled back in one operation. Expect to run it more than once against test
  data before the real run.
- After a successful migration, set `booksClosedThrough` to the migration end
  date so nobody edits history by accident (§4.2 rule 4).
- The migrated Trial Balance MUST balance and the Balance Sheet at the
  migration date MUST satisfy `Assets == Liabilities + Equity` before the
  company is considered live. Do not go live on a migration that does not tie.

**No longer blocked, and no longer needed:** there is no history to migrate
(§16.4, revised). Opening balances at a start date is the whole of it, and that
already exists.

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

**Confirmed configuration (§16.1): `baseCurrency = PHP`, with clients invoiced
in either PHP or USD.** Note carefully which side of the books this puts the FX
on, because it is the opposite of what the consultant-in-PHP framing suggests:

- **Payables are in base currency.** Consultants are paid in PHP and other
  expenses are incurred in PHP, so work orders, bills, and their payments never
  convert. No FX on the A/P side at all in normal operation.
- **Receivables are where FX lives.** A USD invoice in a PHP-base company
  carries an `fxRate`, its A/R is relieved at that **historic invoice rate** on
  payment, and the difference against the payment's rate books to Realized FX
  Gain/Loss. Partial payments relieve A/R pro rata at the invoice rate (§4.3).

Build and test the FX path in **both** directions regardless — the seed data
includes a USD-base company with PHP work orders, and the rules in §4.3 are
symmetric — but the production company is PHP-base and its live FX path is the
receivables one. The setup wizard still shows the "this cannot be changed later"
warning, because changing base currency after postings exist is not supported.

Formatting: currency is always displayed with an explicit code (`PHP 12,500.00`,
`USD 250.00`), never a bare symbol, because two currencies coexist on screen.

---

## 6. Customers, consultants, vendors, and items

**Customer:** name, email(s) for invoicing, billing address, default currency,
default payment terms (Net 15/30/etc.), notes, active flag.

**Consultant:** name, default currency (PHP), default rate, default expense/COGS
account, notes, active flag, an optional link to a `User` record so they can log
in to the time clock, and an **email recipient setup**:

- `primaryEmail` (required if they are ever to be emailed)
- `ccEmails` (a list — some consultants want a manager or agency copied)
- `sendEmails` (boolean; a consultant may be paid but never emailed)
- `externalRef` — a stable code for this consultant. The user's import sheet
  identifies people **by name only** (§8.3), so this is optional; it exists for
  a future sheet that carries a code.
- `importAliases` — the list of spreadsheet spellings that resolve to this
  consultant. Every manual "map this to…" decision in the import validation
  report appends to it, so a name only ever has to be mapped once.

The recipient setup is per consultant and is what the bulk send in §10.1 uses.
Do not let a consultant with `sendEmails = true` and no `primaryEmail` be saved.
A consultant with no linked user simply cannot clock in — that's valid.

**Vendor — one list, two kinds.** Consultants and regular suppliers are the
same kind of record: someone the business owes money to. They live in one
`Vendor` table with a **`kind`** of `CONSULTANT` or `REGULAR`, chosen when the
vendor is created and changeable afterwards only while the vendor has no
postings. A single list means "is this person already set up?" has one answer,
and the ledger's payable lines carry one `vendorId` rather than two nullable
party columns.

Shared fields: name, email, default currency, default expense/COGS account,
payment terms, notes, active flag.

`kind = CONSULTANT` adds:

- `defaultRate` — pre-fills work order lines
- an optional link to a `User` record, so they can log in to the time clock. A
  consultant with no linked user simply cannot clock in — that's valid
- the **email recipient setup** used by the bulk send in §10.1:
  - `primaryEmail` (required if they are ever to be emailed)
  - `ccEmails` (a list — some consultants want a manager or agency copied)
  - `sendEmails` (boolean; a consultant may be paid but never emailed)
  - `externalRef` and `importAliases` — how the import in §8.3 recognises this
    person in a spreadsheet that names them by name alone

`kind = REGULAR` uses only the shared fields. Keep that form short; this is not
a procurement system.

Which section sees which kind is not decoration — it is the point (§2.1). The
`CONSULTANTS` section sees `kind = CONSULTANT` and nothing else; the `VENDORS`
section sees `kind = REGULAR` and nothing else. **Filter by kind in the data
layer, not in the view.** A/P aging (§12.6) groups by vendor and is filtered the
same way, so a vendors-only user sees a payables report covering regular
vendors alone.

Work orders (§8.1) are only ever raised against a `CONSULTANT`; vendor bills
(§8.2) against either kind, though in practice a consultant's payable comes
from a work order.

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

### 7.1a Sales orders

A **sales order** records what a customer has agreed to buy, before there is an
invoice. It is **not an accounting record**: confirming one posts nothing, and
revenue is recognised only when an invoice is issued (§7.1). Anything else books
income for work that has not been billed.

`SalesOrder`: `companyId`, `customerId`, `orderNumber` (allocated on
confirmation, own sequence), `orderDate`, `expectedDate?`, `currency`, `fxRate`,
`status`, `memo`, `total`, `convertedInvoiceId?`.
`SalesOrderLine`: same shape as an invoice line — `itemId?`, `description`,
`quantity`, `rate`, `amount`, `incomeAccountId`.

States: `DRAFT` → `CONFIRMED` → `INVOICED` | `CANCELLED`. Confirmation allocates
the number. **Convert to invoice** copies the lines into a `DRAFT` invoice,
links the two, and moves the order to `INVOICED`; issuing that invoice is what
posts. A partially invoiced order is out of scope for the MVP — one order
becomes one invoice.

The order list shows what is agreed but not yet billed, which is the number the
sales side actually wants. It appears nowhere in the P&L, and that is correct.

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
invoices, and either emails them or
leaves them as drafts. The job MUST be idempotent — keyed on
`(templateId, scheduledDate)` — so a double-run never issues two invoices.

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
approval, **defaulting to the work order's own `issueDate`**, editable by the
approver), `dueDate`, `currency`
(usually PHP), `fxRate`, `status`, `memo`, `total`, `amountPaid`, `balanceDue`,
`lastEmailedAt`.

`WorkOrderLine`: `description`, `quantity`, `rate`, `amount`, `expenseAccountId`.

> **Description, quantity, and rate are the three fields the user named
> explicitly.** They are the heart of this document — make the line editor fast:
> keyboard-navigable, add-row on Tab from the last field, running total visible.

**Numbering.** Work order numbers are a per-company prefix plus a sequence,
both company settings: **prefix `WO`, first number `1001`**, giving `WO1001`,
`WO1002`, `WO1003` with no zero-padding. The sequence is per company and
gap-free, allocated inside the transaction that approves the document (§7.1).
Drafts have no number; screens that need to show one display the **next number
in the sequence as a preview**, clearly marked as provisional, rather than
reserving it. Invoice numbering works the same way with its own prefix and
start value.

Status machine: mirrors the invoice machine in §7.1 exactly, with `APPROVED` in
place of `ISSUED` — including the direct `APPROVED → PAID` transition, derived
paid states, number allocation on approval, and the block on editing or voiding
a document that has payments applied.

`APPROVED` is what posts the A/P entry, dated `approvedAt` — which defaults to
the work order's `issueDate`, **not** to the day the approve button is clicked.
Approving August work in September therefore books the expense in August, where
it belongs. If that date falls in a closed period the posting is rejected per
§4.2 rule 4 and the approver must either reopen the period (`OWNER` only) or
move `approvedAt` forward deliberately. **Emailing is
independent of approval** — the user may email a draft work order for the
consultant's confirmation before approving it, and doing so posts nothing.

`Bill` (payables side): one model covering both work-order payments and vendor
bill payments, structurally identical to `Payment` in §7.1 — a `BillPayment`
header (`date`, `amount`, `currency`, `fxRate`, `paymentAccountId`, `method`,
`reference`, `notes`, `consultantId` or `vendorId`) with `BillPaymentApplication`
children pointing at either a `WorkOrder` or an `Expense` recorded as a bill.
One payment can settle several documents; reversal behaves as in §7.1.

**Time entries do not feed work orders.** The user was explicit: the time clock
is attendance tracking, and work orders are created manually. Do not build an
"import hours into work order" flow. (Do put `consultantId` and a date range on
the work order form so a future version *could* — but no UI for it now.)

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

### 8.2a Recurring bills

`RecurringBillTemplate`: a `RecurringBillTemplate` carries everything §8.2 needs
to record one expense — `kind`, `vendorId?`, `amount`, `currency`, `fxRate`,
`expenseAccountId`, `paymentAccountId?`, `paymentTermsDays`, `description`,
`reference?` — plus the same schedule fields as a recurring invoice (§7.2):
`frequency`, `dayOfMonth?`, `dayOfWeek?`, `monthOfYear?`, `startDate`,
`endDate?`, `occurrenceLimit?`, `nextRunDate`, `lastRunDate?`,
`occurrenceCount`, `isPaused`.

Rent, a retainer, a utility. The daily job records each due occurrence as a
§8.2 expense of the template's kind, through the same `recordExpense` service
every other expense goes through.

Three rules, and they matter:

1. **It posts.** Unlike a recurring invoice, which leaves a draft (§7.2),
   a recurring bill records and posts on its date. A bill goes to nobody — it
   records what is owed — and the point of the feature is that A/P Aging is
   true on the first of the month without anyone typing the rent in. A wrong
   one is reversed and reposted like any other bill (§4.2 rule 3).
2. **Once per period.** A unique `(templateId, scheduledDate)` row on
   `RecurringBillRun` is claimed before anything else happens, so the job MUST
   be safe to run twice — which it will be, since two schedulers run against
   this deployment on purpose.
3. **Catch up, do not collapse.** A template that has not run for months
   records one expense per missed period. Each period was genuinely owed.

The schedule arithmetic is shared with §7.2 rather than reimplemented: one
place to be right about "the 31st" in February and about a fortnightly cadence
that must not drift.

A run that cannot post — a closed period, a template missing its vendor —
records the reason on its `RecurringBillRun` and shows it on the screen. A
scheduled job that fails silently at 06:00 is worse than one that fails loudly.

### 8.3 Bulk work order creation from an Excel file

The user prepares consultant work in a spreadsheet and needs to turn it into
many work orders in one go. This is a core workflow, not a convenience feature —
build it properly, with a review step.

**Accepted input:** `.xlsx` (primary) and `.csv`. Parse server-side with
SheetJS or ExcelJS. Read the **first worksheet** by default but let the user
choose a sheet if the workbook has several.

**Downloadable template.** The import screen MUST offer a "Download template"
button producing a formatted `.xlsx` with the expected headers, one example row,
and a second sheet listing valid consultant codes, currencies, and expense
account codes for that company. Most import failures are avoided here.

**The columns — this is the user's real sheet (supplied 2026-08-21), not an
invented layout.** Header row required; matching is case- and
whitespace-insensitive. Keep the definitions in one place (a single
`WORK_ORDER_IMPORT_COLUMNS` map driving both the template generator and the
parser) so a future column is a data change, not a rewrite.

| Column | Required | Notes |
|---|---|---|
| `Work Order Date` | yes | The work order's `issueDate`. Accepts Excel serial dates and `M/D/YYYY` text (the user's format — `8/15/2026` is 15 Aug 2026). The interpreted date is echoed back in the validation report so a D/M vs M/D mistake is caught before commit. `dueDate` is derived from the consultant's terms. The A/P entry posts on this date too: `approvedAt` defaults to it, so approving a batch dated 15 Aug books the expense on 15 Aug however late the approval happens (§8.1) |
| `Consultant Name` | yes | Exact, case- and whitespace-insensitive match against **active** consultants. No code column exists in this sheet, so unmatched names stop in the validation report with a "map this to…" picker, and the choice is saved as an alias on that consultant (`Consultant.externalRef` / alias list) so the same spelling never has to be mapped twice |
| `Line No.` | yes | The grouping key — see below. Integer ≥ 1 |
| `Description` | yes | The work order line description |
| `Account` | yes | Account **name or code**, matched against that company's chart of accounts. Must exist and be active. This is the account the line debits (§4.3), so `Consultant Fees` and `Supplies Expense` can sit on the same work order. An unknown or inactive account is a row error — never fall back to the consultant's default account silently |
| `Quantity` | yes | Numeric, fractional allowed (`0.5` is normal here). May not be zero |
| `Rate` | yes | Numeric. **May be negative** — `(3,000.00)` in accounting parentheses is −3,000, and is how a cash advance recovery or other deduction is expressed. Parsed to `Decimal` from the raw cell; currency symbols, thousands separators, and parentheses handled |
| `Amount` | no | If present it is **checked** against `Quantity × Rate`, not trusted; a mismatch over one cent is a row error |

Everything else is inferred, because the sheet does not carry it: `Currency`
defaults to the consultant's default currency (PHP), and with `baseCurrency =
PHP` (§5) no `fxRate` is needed on the consultant side at all. `Memo` is left
blank. If a column is added to the sheet later, it slots into the map above.

**Multi-line work orders — the `Line No.` rule.** This is the single most
important behaviour in the import:

- A row with `Line No.` **1** opens a **new work order** for that consultant.
- A row with `Line No.` **greater than 1** attaches as another **line on that
  consultant's currently open work order**.
- Grouping is tracked **per consultant**, so rows for different consultants may
  interleave without breaking a group.

So in the sample sheet, Abigail Bautista's single row is a one-line work order,
John Rex Meraveles' rows 1 and 2 are **one work order with two lines** (net
PHP 5,000 after the advance), and Chareze Valencia's rows 1 and 2 are one work
order with two lines hitting two different accounts.

Edge cases, all surfaced in the validation report:

- `Line No.` > 1 with no open work order for that consultant → **error** on
  that row (a stray continuation line, usually a deleted row 1).
- A repeated `Line No.` inside one group → **error** (two rows both claiming
  line 2).
- A gap in the run (1, 3, 4) → **warning**; the lines import in sheet order and
  are renumbered 1, 2, 3 on the created document.
- A work order whose lines net to **zero or less** → **error**. Deductions
  exceeding the work are not a payable (§4.3); handle that outside the import.

**A note on deduction lines.** The importer posts each line to the account the
sheet names, including negative ones. Coding `Cash Advances` to `Consultant
Fees` therefore **reduces reported consultancy expense** by the advance — right
if the advance is a discount on the work, wrong if it is cash already paid to
the consultant and being recovered. In the latter case the line should name an
`Advances to Consultants` asset account, which clears the advance and leaves
expense at its full amount. The system does what the column says; this is a
coding decision on the preparer's side, and the validation report SHOULD show a
gentle notice when a negative line is coded to an income-statement account.

**Mandatory preview and validation step.** Uploading NEVER writes work orders
directly. The flow is: upload → parse → validation report → user confirms →
create. The validation report shows, per row:

- unmatched consultant (with a "map this to…" picker that can be remembered for
  next time via `externalRef`)
- non-numeric quantity, zero quantity, or an unparseable rate (a *negative*
  rate is valid — see the `Line No.` rules above)
- unparseable dates (accept ISO, US, and Excel serial dates; show the
  interpreted date back to the user so they can catch a D/M vs M/D mistake)
- unknown or inactive account in the `Account` column
- missing FX rate where one is needed
- a consultant marked inactive
- a `Line No.` run that is broken, duplicated, or nets to zero or less
- **a likely duplicate** — a work order already exists for the same consultant,
  date, and total. Warn, do not block.

Rows are either **valid**, **warning**, or **error**. Errors block only their
own row. The user chooses "import the N valid rows" or "cancel and fix the
file"; either way, show the counts before they commit. Rejected rows are
downloadable as an annotated `.xlsx` with a reason column appended, so the user
fixes the file rather than hunting through error text.

**What gets created.** Imported work orders are created as **`DRAFT`**, never
approved and never posted to the ledger. Drafts carry no work order number; the
preview shows the numbers they *will* take (`WO1001`, `WO1002`, …) as a
provisional preview, and the real allocation happens gap-free on approval
(§8.1). Bulk-posting financial documents from a
spreadsheet without review is exactly the kind of thing this system exists to
prevent. The user reviews and approves them — see bulk approve below.

**The whole import is one database transaction.** A failure part-way through
leaves nothing behind. Record an `ImportBatch` (`id`, `companyId`, `kind`
(`WORK_ORDER` | `BANK` | `MIGRATION`), `fileName`, `uploadedBy`, `uploadedAt`,
`rowCount`, `createdCount`, `skippedCount`) and
stamp `importBatchId` on every work order it created, so a bad import can be
reviewed as a group and — while every work order in it is still an untouched
`DRAFT` — rolled back in one click.

**Bulk approve.** On the work order list, selecting several `DRAFT` work orders
and choosing "Approve" posts each one's journal entry (§4.3) individually, each
in its own transaction, **each dated its own `issueDate` from the sheet**, with
a results summary naming any that failed and why. A document whose date sits in
a closed period fails as its own row and does not stop the others.
Cap a single bulk operation at 500 documents.

Limits: 5,000 rows or 10 MB per file. Above that, tell the user to split it.

### 8.4 CSV bank import

- `BankAccount`: linked to a GL account of subtype `CASH` (or a credit card
  liability account).
- Upload a CSV. Present a **column mapping UI** (date / description /
  amount / debit-credit columns / reference) and let the user save the mapping
  per bank account so subsequent imports are one click. Support both the
  single-signed-amount and separate-debit-credit-column layouts, and let the
  user pick the date format.
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
  clear error to the user on hard failure.
- **`EmailLog`** for every attempt: `companyId`, `toAddresses`, `cc`, `subject`,
  `bodySnapshot`, `attachmentNames`, `relatedType`/`relatedId`, `status`
  (`QUEUED`, `SENT`, `FAILED`), `gmailMessageId`, `error`, `sentAt`,
  `sentByUserId`, `emailBatchId?` (§10.1), `attemptCount`. Show this log in the
  UI, filterable by document and by batch.
- Templates per company, editable in Settings, with a live preview and a "send
  test to myself" button: `INVOICE`, `INVOICE_REMINDER`, `WORK_ORDER`,
  `PAYMENT_RECEIPT`.
- **Every email screen MUST show a preview and require an explicit Send click**,
  except recurring templates set to `AUTO_SEND`. In development, a
  `EMAIL_DRY_RUN=true` env var MUST short-circuit actual sending and just write
  the log — do not send real email from a dev machine.

### 10.1 Bulk work order send

A dedicated screen for emailing many work orders at once, each to its own
consultant. This is how the user actually works: a batch of work orders is
created (often by the Excel import in §8.3), then all of them go out together.

**The screen.** A filterable list of work orders — filter by consultant, date
range, status, import batch, and **"not yet emailed"** — with a checkbox per row
and a select-all-matching-the-filter control. Columns: consultant, work order
number, date, total, status, recipients, last emailed at. Default filter:
approved work orders never emailed.

**Per-row recipient resolution.** Each work order resolves its own recipients
from that consultant's setup in §6 — `primaryEmail` plus `ccEmails`. Show the
resolved addresses in the row so the user can see exactly where each one is
going before sending. Rows that cannot be sent (no email on file,
`sendEmails = false`) are shown **greyed out with the reason inline** and are
excluded from selection rather than silently dropped.

**Confirmation step.** Selecting rows and clicking "Send" opens a summary:
*"Send 14 work orders to 9 consultants (23 recipients)"*, a full list of
consultant → addresses, the template that will be used, and a preview of one
rendered email. Sending requires an explicit confirm. There is no undo on email.

**Sending behaviour:**

- **One email per work order**, with that work order's PDF attached (§11).
- When one consultant has several selected work orders, default to **one email
  per work order** but offer a "combine into one email per consultant" toggle,
  which attaches all their PDFs to a single message. Both paths must be
  implemented; the combined path is what the user will reach for on a big batch.
- The batch is **queued and processed in the background**, not sent inside the
  HTTP request. Throttle to stay inside Gmail's limits (§10), retry transient
  failures with exponential backoff, and never retry a hard bounce.
- **A partial failure must not abort the batch.** Each send succeeds or fails
  independently.
- Progress UI: a live "12 of 14 sent" indicator, then a results panel listing
  each success and each failure with its reason and a **"Retry failed only"**
  button. The retry must not re-send anything that already succeeded — key the
  queue on `(batchId, workOrderId)` and make it idempotent.
- Every send writes its own `EmailLog` row (§10) carrying `emailBatchId`, so the
  batch can be reviewed later from the work order or from a batch history list.
- Each successfully sent work order gets `lastEmailedAt` stamped.

**Sending does not change accounting status.** Emailing a `DRAFT` work order
does not approve it and posts nothing (§8.1). Offer "Approve and send" as an
explicit combined action for the common case, but keep the two operations
separate underneath, and make the confirmation summary state plainly how many of
the selected work orders are still drafts.

Cap a single batch at 200 emails and tell the user to split beyond that.

The same screen pattern SHOULD be reused for bulk-sending customer invoices —
build the list, selection, confirmation, and queue as shared components rather
than one-off code for work orders.

---

## 11. PDF generation

- Server-side rendering of an HTML template to PDF (Puppeteer/Playwright, or
  React-PDF — your call; pick one and stay consistent).
- Documents: **Invoice**, **Work Order**, and **Payment Receipt**.
- Company branding in Settings: logo upload, company name, address, email,
  phone, tax/registration number, footer text (payment instructions,
  bank details). These appear on all three documents.
- Filenames: `Invoice-{number}-{customer-slug}.pdf`,
  `WorkOrder-{number}-{consultant-slug}.pdf`.
- The PDF must be downloadable from the document screen as well as attachable to
  email.

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
6. **A/P Aging** — same, per vendor, and **filterable by vendor kind** so the
   consultant side and the regular-vendor side can be read separately. A user
   holding only `VENDORS` sees the regular-vendor rows only (§2.1).
7. **Time report** — hours per consultant per day/week/period in PHT.
8. **Sales by customer** — invoiced and paid totals per customer for a period,
   with open balance. Part of the `SALES` section rather than `REPORTS`, because
   it is the report the sales side lives in.

Fiscal year start month is a company setting (default January).

**Dashboard** (landing page for OWNER/BOOKKEEPER): cash balances, income vs
expenses for the last 6 months, A/R outstanding and overdue, A/P outstanding,
unmatched bank transactions count, consultants currently clocked in. Built in
Phase 9, because its last two tiles depend on Phases 6 and 8.

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
- **Vitest** for unit tests, **Playwright** for a handful of end-to-end flows
- Deployable to a single VPS via `docker compose` (app + Postgres). A
  Vercel + hosted-Postgres path is a `SHOULD`, not a `MUST` — note in the README
  that it requires S3-compatible object storage and an external PDF service,
  since Vercel's filesystem is ephemeral and headless Chrome does not fit its
  default runtime.

### File storage

Receipts, company logos, and generated PDFs need somewhere to live. Put every
read and write behind a small `StorageAdapter` interface with two
implementations: `LocalDiskAdapter` (default, a mounted volume in the compose
file) and `S3Adapter` (any S3-compatible bucket), chosen by env var. No code
outside the adapter touches a file path. This is ten minutes of work now and is
the difference between the two deployment paths above being possible or not.

Generated PDFs are **cached, not authoritative** — they must be regenerable from
the document at any time, so a lost storage volume never loses financial data.

### Non-negotiables

- **Money:** `Decimal` (Prisma `Decimal` / `decimal.js`) or integer minor units.
  Never floats. A lint rule or code review note enforcing this is welcome.
- **Dates:** accounting dates are `DATE` columns with no time zone. Event
  timestamps (clock in/out, email sent) are `TIMESTAMPTZ` in UTC.
- **Audit log:** an append-only `AuditLog` of who changed what and when for
  every financial document and every user/role change.
- **Soft delete** for master data (customers, consultants, accounts). Hard
  delete is forbidden for anything referenced by a journal line.
- **Sequences:** invoice/work-order/journal numbers are gap-free per company and
  allocated inside the same transaction as the document, safe under concurrency.
- **Backups:** a documented `pg_dump` command in the README and a "download a
  full data export (CSV bundle)" button in Settings. The user must never feel
  their books are trapped in this app.
- **Security:** rate-limit login, HTTP-only session cookies, CSRF protection on
  mutations, no secrets in the repo, `.env.example` committed with every
  variable documented.
- **Errors:** never swallow a posting error. If a journal entry fails to
  balance, roll back the whole document operation in one DB transaction.

### Seed data

`npm run seed` MUST create: one organization, two companies (one with
`baseCurrency = USD`, one with `PHP`, to exercise the FX path), a standard chart
of accounts for each, an owner user, a bookkeeper user, three consultants (two
with logins), four customers, three vendors, ~60 invoices and work orders in
mixed statuses, ~80 expenses of both kinds, a month of time entries, and a
sample bank CSV in `/fixtures`, and a **sample work order import workbook** in
`/fixtures` **using the user's real column layout** (Work Order Date,
Consultant Name, Line No., Description, Account, Quantity, Rate, Amount) and
containing ~120 rows: multi-line `Line No.` runs, single-line rows, two rows for
different accounts on one work order, a negative advance line, an unmatched
consultant name, a stray `Line No. 2` with no line 1, a duplicated line number,
a group netting to zero, a malformed date, and a likely duplicate — so the
validation report in §8.3 has something real to chew on. Print the seeded
login credentials at the end.

**The seeded transactions MUST span a fiscal-year boundary** — roughly 18 months
of history, not three — so that the retained-earnings roll-forward (§12.2) is
actually exercised. Include at least one PHP work order in the USD company and
at least one **USD invoice in the PHP company settled at a different rate** —
that second one is the FX path the production company actually runs (§5) and it
must be in the fixture, not just the mirror-image case. Also one partial
payment, one payment applied across two invoices, one voided invoice, and one
time entry that crosses midnight Manila time. The seed is the test
fixture for the trickiest rules in this spec; treat it that way.

---

## 14. Build phases

Ship each phase working and tested before starting the next.

**Phase 1 — Foundation.** Project scaffold, Postgres + Prisma, auth, user
invites and password reset, Organization/Company/User/Membership, company setup
wizard (base currency, fiscal year, time zones), company switcher, role
middleware, **section grants (§2.1)**, storage adapter, layout and nav, audit
log, seed script skeleton.
Test: a user in company A cannot read company B's data; a user holding only
`VENDORS` cannot read a customer, an invoice or a consultant by direct ID.

**Phase 2 — The ledger.** Account model + chart-of-accounts CRUD + default CoA
template, `JournalEntry`/`JournalLine`, the single `postJournalEntry` service,
manual journal entries, opening balances, and the **Trial Balance** report.
Test: unbalanced entries are rejected; trial balance totals match.

**Phase 3 — Money in.** Customers, items, **sales orders (§7.1a)**, invoices
with the full status machine, payments with applications (one-to-many), payment
reversal, A/R aging, sales by customer. All behind the `SALES` section. Test:
every posting rule in §4.3 for the receivables side; confirming a sales order
posts nothing and converting it produces a draft invoice.

**Phase 4 — Money out.** The one `Vendor` table with `kind` (§6), work orders
(description/quantity/rate) against consultants, bill payments, expenses (both
`DIRECT` and `BILL`), A/P aging filterable by kind. Split across the
`CONSULTANTS` and `VENDORS` sections, which is what makes the separation real
rather than cosmetic. Test: payables posting rules; FX gain/loss on a PHP work
order settled at a different rate; the line-rounding residual case; a
`VENDORS`-only user cannot read a work order or a consultant's rate.

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
work order. Test: dry-run mode logs without sending.

**Phase 8 — Batch operations.** The largest phase; consider splitting it into
8a and 8b if it runs long.

- *8a — Work order batch.* Excel work order import (§8.3): template download,
  parser, validation report, consultant mapping, `ImportBatch`, bulk approve.
  Then the bulk send screen (§10.1): filtering, selection, recipient resolution,
  confirmation summary, background queue, per-row results, retry-failed-only.
  Test: a 200-row sheet with mixed `Line No.` runs produces the right number of
  work orders with the right number of lines each, and a two-line group with a
  negative advance line nets correctly and posts a balanced entry on approval; an import with 3 bad rows imports the
  rest and returns an annotated reject file; a bulk send where 2 of 10 fail
  reports exactly those 2 and a retry re-sends only those 2.
- *8b — Recurring, bank import, and history migration.* Recurring invoice
  templates on the Phase 6 scheduler, upcoming list, CSV bank import with saved
  column mappings, dedupe, matching screen with all three match outcomes, and
  the historical migration importer (§4.4) — open items as documents,
  summarised prior periods, opening balances, `booksClosedThrough` set on
  completion. Test: scheduler idempotency; re-importing the same CSV creates
  zero duplicates; linking a bank line to an already-recorded payment posts
  nothing; a migrated fixture spanning two fiscal years ties on the Trial
  Balance and puts the earlier year's profit in retained earnings.

**Phase 9 — Dashboard and polish.** Dashboard, mobile pass on the time clock,
empty states, keyboard shortcuts in line editors, full data export, README with
deployment and backup instructions, `DECISIONS.md`.

---

## 15. Acceptance criteria

The MVP is done when all of these pass, demonstrated against seeded data:

1. Two companies exist with separate books; switching companies changes every
   figure on screen, and cross-company access is impossible by direct URL.
2. **Section access holds.** A bookkeeper granted only `VENDORS` sees vendor
   bills and expenses, and cannot reach a customer, an invoice, a sales report
   or a consultant's rate — by navigation or by typing the URL. A `SALES`-only
   user is refused work orders the same way. Both refusals come from the data
   layer, not just the menu.
3. A customer invoice can be created, previewed as PDF, emailed via Gmail, part-
   paid, then fully paid — and A/R on the Balance Sheet moves correctly at each
   step.
4. A sales order is confirmed, posts nothing, and converts into a draft invoice
   whose issue is what finally posts revenue.
5. A work order with description/quantity/rate lines can be created, emailed to
   a consultant, approved, and paid — and A/P moves correctly at each step.
6. An Excel file in the user's own layout imports as draft work orders: a
   `Line No.` run groups into one multi-line document, each line posts to the
   account its row names, a negative advance line reduces the payable without
   unbalancing the entry, bad rows are reported without blocking the valid ones,
   and nothing posts to the ledger until approved — at which point numbering
   starts at `WO1001` with no gaps.
7. From the bulk send screen, ten work orders across six consultants are
   selected and sent in one action — each consultant receives their own
   work order PDF at the addresses configured on their record, consultants with
   no email on file are visibly excluded rather than silently skipped, and a
   simulated failure on two of them is reported and retried without re-sending
   the eight that succeeded.
8. A vendor is created as a regular vendor, its bill recorded and marked paid,
   and it never appears in the consultant list or the consultant side of A/P
   aging.
9. An expense can be recorded and appears in the P&L in the right period.
10. **The Balance Sheet balances**, and its current-year earnings figure equals
    the P&L net income for the same fiscal year to date. It also balances when
    dated inside a *prior* fiscal year, with that year's profit appearing in
    retained earnings on a later-dated report.
11. Every number on the P&L and Balance Sheet drills through to journal lines
    and then to source documents.
12. A consultant logs in, sees only the time clock, clocks in and out, and the
    admin sees those times in PHT on the timesheet grid — including an entry
    that crosses midnight Manila time.
13. A recurring monthly invoice template generates its invoice on schedule, once
    and only once, even if the job runs twice.
14. A bank CSV imports, maps columns, and dedupes on re-import. A transaction can
    be **linked** to an already-recorded payment without posting anything new,
    **and** separately can create a payment against an open invoice — cash is
    counted exactly once either way.
15. A PHP-denominated work order in a USD-base company posts converted amounts to
    the GL; settling it at a different rate books an FX gain or loss and leaves
    the A/P control account at exactly zero for that document; and a partial
    payment relieves A/P pro rata at the document's rate.
16. ~~The historical spreadsheet migrates (§4.4).~~ **Not applicable** — the
    user confirmed on 2026-08-21 that there is no history to bring in, so the
    books start from opening balances. The criterion is retired rather than
    unmet.
17. `npm run seed && npm test && npm run build` all succeed from a clean clone.
18. The README explains local setup, deployment, backup, and restore.

---

## 16. Decisions from the user

All eight questions in this section were put to the user and answered on
**2026-08-20**. They are settled — build to them. Two carry an outstanding
**input** (a file the user still owes), noted below; neither blocks the phases
before it.

1. **Base currency — settled: `baseCurrency = PHP`.** Clients may be invoiced in
   **PHP or USD**; consultants and other expenses are all PHP. So the FX path is
   live on the **receivables** side and dormant on the payables side — the
   opposite of what §5 originally assumed. §5 and the seed data now say this.
   Still build and test both directions; the rules in §4.3 are symmetric and the
   seed keeps a USD-base company to exercise the mirror case.
2. **Sales tax / VAT — settled: none, but built.** Ship the per-line `TaxRate`
   model (name, %, liability account) with no rates configured, so invoices are
   untaxed. Turning tax on later is a settings change, not a migration.
3. **Consultant classification — settled: contractors, no withholding.** Every
   consultant payment is a straight contractor expense. No withholding fields,
   no 1099/BIR anything (§1 non-goals).
4. **Existing data — revised 2026-08-21: there is no history to bring in.**
   The user confirmed the books start empty. §4.4 is therefore not built and
   acceptance criterion 16 does not apply. The shape stays documented in §4.4
   in case history turns up later; going live is opening balances at a chosen
   start date, through the same `OPENING_BALANCE` entry as any other company.
   **Input still needed:** the actual spreadsheet and the intended start date.
   The parser cannot be written against a file nobody has seen — layers 1 and 3
   get built against the seed fixture meanwhile.
5. **Fiscal year — settled: January start.** Company setting stays at month 1.
   The prior-fiscal-year Balance Sheet test in §12.2 and Phase 5 still applies.
6. **Approval flow — settled: no separate approver.** Whoever creates a work
   order can approve it, and approval is what posts A/P. Bulk approve from the
   list (§8.3) stands as written.
7. **Excel import layout — settled and supplied (2026-08-21).** The real sheet
   is Work Order Date, Consultant Name, Line No., Description, Account,
   Quantity, Rate, Amount, and §8.3 is now written to it. Three things came out
   of the sample that were not in the original guesses: grouping is by a
   **`Line No.` run** rather than a ref column, **each line names its own
   account**, and **negative lines are normal** (cash advance recovery, shown
   in accounting parentheses). Work order numbering starts at **`WO1001`**.
   One coding point is the user's to decide per row, not the system's: a
   negative line coded to `Consultant Fees` reduces reported expense, while one
   coded to an `Advances to Consultants` asset account clears the advance and
   leaves expense whole (§8.3).
8. **Bulk send grouping — settled: one email per work order.** Each work order
   goes out with its own PDF to that consultant's configured recipients. The
   "combine into one email per consultant" toggle (§10.1) is still built and
   available, just not the default.

### 8.4a Bank reconciliation

`BankReconciliation`: `companyId`, `bankAccountId`, `statementDate`,
`statementEndingBalance`, `openingBalance`, `status`
(`IN_PROGRESS` | `COMPLETED`), `completedAt?`, `reopenedAt?`,
`startedByUserId?`, `completedByUserId?`. `BankReconciliationLine` links it to
each cleared `JournalLine`, with `journalLineId` **unique** across the table.

Statement-to-book sign-off, per account. This is a different question from
matching (§8.4): matching asks what a statement line corresponds to,
reconciliation asks whether the two sides agree and — when they do not — which
entries account for the gap.

So it works over **journal lines against the bank's GL account**, not over
imported statement rows. A payment recorded in the app that never reached the
statement — an uncashed cheque — is invisible to a statement-row view, and is
exactly what reconciliation exists to surface.

The arithmetic is the feature:

    cleared balance = opening balance + Σ(cleared lines)
    difference      = statement ending balance − cleared balance

Rules:

1. **Zero or nothing.** A reconciliation MUST NOT complete while the difference
   is non-zero. "Near enough" is how a reconciliation stops being evidence.
2. **Once only.** `journalLineId` is unique on `BankReconciliationLine`, so a
   line can clear on at most one statement and the same cash can never be
   signed off twice.
3. **Completing locks.** Entries cleared by a completed reconciliation cannot
   be edited or deleted — only reversed forward, which posts on a later date
   and lands on the next statement where it belongs. Enforced in `amendPosting`
   and `eraseEntry`, the two functions every edit and delete pass through.
4. **The opening balance carries.** A new reconciliation starts from the
   previous completed one's ending balance, stored rather than recomputed so
   history cannot drift under a later edit.
5. **Reopening is owner-only and last-first.** Only the most recent
   reconciliation for an account can be reopened, because a later one opened
   from its balance.

One in-progress reconciliation per account: a second person starting one joins
the first's work rather than opening a rival copy. Its statement date and
closing balance stay editable while it is open — a mistyped closing balance is
the commonest reason a difference will not close.

