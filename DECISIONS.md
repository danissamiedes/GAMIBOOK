# DECISIONS.md

Choices made while building Ledger, and why. Anything the spec left to judgment
that turned out to matter belongs here.

## Answered by the user — 2026-08-20

The eight open questions in SPEC.md §16 were put to the user and answered. The
answers are recorded in §16 itself; this is the short form, plus what each one
changed in the spec.

| #   | Question                  | Answer                                                         | Changed                                                                                                            |
| --- | ------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | Base currency             | **PHP**, clients invoiced in PHP **or USD**                    | §5 rewritten: FX is live on the receivables side, dormant on payables. Seed gains a USD invoice in the PHP company |
| 2   | Sales tax / VAT           | None charged; build `TaxRate` and leave it unused              | No change — this was the spec default                                                                              |
| 3   | Consultant classification | Contractors, no withholding                                    | No change — spec default                                                                                           |
| 4   | Existing data             | ~~Migrate the spreadsheet history~~ → **revised 2026-08-21: no history to bring in** | §4.4 documented but not built; acceptance criterion 16 retired                                    |
| 5   | Fiscal year               | January start                                                  | No change — spec default                                                                                           |
| 6   | Approval flow             | No separate approver                                           | No change — spec default                                                                                           |
| 7   | Excel import layout       | **Match the user's existing spreadsheet**                      | §8.3 column table marked provisional; columns must live in one map driving template + parser                       |
| 8   | Bulk send grouping        | One email per work order                                       | No change — spec default; combine toggle still built                                                               |

### Consequence worth restating

Answer 1 inverts the FX assumption the spec was written under. Consultants being
paid in PHP does **not** mean FX only touches the payables side — with PHP as
base currency, consultant payments never convert at all, and the only live FX in
the production company is a **USD client invoice settled at a different rate**.
The A/R control account clears to zero only because the receivable is relieved at
the historic invoice rate (SPEC §4.3). That is the path to test hardest.

## Import layout received — 2026-08-21

The user supplied their real work order spreadsheet. SPEC §8.3 is now written to
it rather than to an invented column set.

Layout: `Work Order Date | Consultant Name | Line No. | Description | Account |
Quantity | Rate | Amount`.

Three things it changed:

1. **Grouping is a `Line No.` run, not a ref column.** `Line No. = 1` opens a
   new work order for that consultant; 2, 3, … attach to it. Tracked per
   consultant so rows may interleave.
2. **Each line names its own account.** One work order can debit Consultant Fees
   on one line and Supplies Expense on another, so §4.3's work order posting
   rule now reads "DR line account(s)" rather than a single consultant cost
   account.
3. **Negative lines are normal.** A cash advance recovery appears as
   `(3,000.00)`. Negative lines post as a credit to their own account; the net
   total must still be greater than zero or it is not a payable.

Numbering: work order sequence starts at **WO1001**, prefix and start value
being company settings. Allocation stays on approval (gap-free); drafts show the
next number as a clearly-marked preview rather than reserving it.

### Two follow-ups answered — 2026-08-21

- **Numbering stays on approval.** Imported drafts carry no number; the preview
  shows the numbers they will take, marked provisional. Keeps the sequence
  gap-free when drafts are discarded. (The alternative — numbering at import —
  was offered and declined.)
- **A/P posts on the sheet's Work Order Date**, not on the approval click.
  `approvedAt` now defaults to the work order's `issueDate`, so approving August
  work in September books the expense in August. A date inside a closed period
  fails that row and leaves the rest of the batch alone.

### Open coding point, flagged not decided

In the sample, the `Cash Advances` line is coded to **Consultant Fees**, which
credits that account and reduces reported consultancy expense — correct only if
the advance is a discount on the work. If the advance is cash already paid to
the consultant, the line should name an **Advances to Consultants** asset
account so the advance clears and expense stays whole. The importer posts to
whatever the column says; the validation report will show a soft notice when a
negative line is coded to an income-statement account. Raised with the user;
left to their per-row judgement.

## Outstanding inputs

Neither blocks the phase it sits in, but both block go-live:

- ~~**The historical spreadsheet and the books' start date**~~ — resolved
  2026-08-21: **there is none.** The books start empty, so §4.4 is not built and
  acceptance criterion 16 is retired rather than unmet. Going live is opening
  balances at a chosen date, which already works.
- ~~The work order spreadsheet~~ — received 2026-08-21, see above.

Nothing now blocks go-live except connecting Gmail, and that only blocks
*delivery*: every other part of sending — composing, attaching, previewing,
logging, the bulk send screen — works in dry run and is tested.

## Build decisions

### Phase 2 — the ledger (2026-08-21)

**Database triggers, not just service checks.** SPEC §4.2 asks for the hard
rules "in code and with a DB constraint or trigger where you can". All of it is
in the database: CHECK constraints for non-negative amounts and one side per
line, deferred constraint triggers for "at least two lines" and "debits equal
credits", and BEFORE triggers making posted entries and lines immutable. The
service produces the readable error; the database is why the rule holds. A test
asserts every trigger is enabled, because a disabled trigger is silent — the
books would keep accepting writes and nothing would look wrong until a report
did not balance.

**Test teardown uses TRUNCATE.** The first version disabled the immutability
triggers to clear fixtures, and a crash between disable and re-enable left one
switched off in the test database — the exact hole the trigger exists to close.
TRUNCATE does not fire row-level triggers, so teardown never touches them.

**Opening balances are entered on each account's normal side.** A positive
figure against a bank account is a debit and against a credit card a credit,
matching the statement being copied from; a negative figure flips sides, for an
overdrawn account. Income and expense accounts are refused outright — prior-year
results belong in retained earnings, computed at report time (SPEC §12.2).

**`Advances to Consultants` (1200) is in the default chart of accounts.** It is
the account a `Cash Advances` import line should name if the advance is cash
already paid and being recovered, rather than a discount on the work — see the
open coding point above.

**Reversal links forward, not backward.** The original entry gets
`reversedByEntryId`; that single column is the one field the immutability
trigger allows to change, so the audit trail reads in both directions without
making entries editable.

## Section access, vendor kinds and sales orders — 2026-08-21

The user asked for the app to be divided into Sales, Consultant and Regular
Vendor sections, with access filtered per user, and for vendors to be classified
as one or the other. Four questions were put to them and answered:

| Question                            | Answer                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| One vendor list or two tables?      | **One `Vendor` table with `kind` = CONSULTANT \| REGULAR**                        |
| How should sections work?           | **Per-user grants on top of the role**, enforced in nav, route and data layer     |
| What is a Sales Order?              | **Non-posting; converts to a draft invoice.** Revenue is recognised only on issue |
| What can the Vendors section reach? | Bills and payments, **plus direct expense entry**                                 |

SPEC §2.1 (new), §6 (rewritten), §7.1a (new), §12.6, §12.8, Phases 1/3/4 and the
acceptance criteria were updated to match.

**Sections are a second axis, not a replacement for roles.** The role says how
much someone can do; the section says which part of the business they can see.
An OWNER implicitly holds every section and cannot have one removed — someone
has to be able to see the whole business. A CONSULTANT holds none; the time
clock is that role's only screen, not a section.

**The guard lives in the data layer.** `withSectionScope()` throws a
`SectionError`, and every page and action obtains its scope through it. The nav
only shows what the membership holds and a refused page redirects to a plain
explanation, but neither of those is the protection: a vendors-only user who
types an invoice URL is refused by the scope, not by the menu. The test proves
exactly that, by ID.

**Retrofit, not a rewrite.** Phases 1–3 were already built against
`financialScope()`; each screen now names its section instead. Sales screens
take `SALES`, the ledger and reports `REPORTS`, chart of accounts and company
settings `SETTINGS`. The dashboard stays role-only and will show per-section
tiles.

### Phase 4 — money out (2026-08-21)

**One `PayableStatus` enum for work orders and bills.** SPEC §8.1 names the
open state `APPROVED` on a work order and §8.2 names it `OPEN` on a bill. They
are the same state, so the enum has one value, `APPROVED`, and the expenses
screen labels it "open". Two enums differing by a synonym would be a trap for
whoever writes the next status check.

**The work order's A/P entry is dated the work order date.** `approvedAt`
defaults to the document's own `issueDate` rather than today, per the user's
answer of 2026-08-21, so approving August work in September still books the
expense in August. A date inside a closed period fails that document alone.

**Deduction lines post to their own account.** A negative line credits the
account its row names instead of debiting a negative amount, which keeps the
entry legal and makes a `Cash Advances` line coded to `Advances to Consultants`
clear the advance while leaving consultant expense whole. A work order netting
to zero or less is refused: that is a receivable, not a payable.

**`JournalLine.consultantId` was dropped.** With consultants inside the vendor
table, the party dimension on payables is `vendorId` alone. Two nullable columns
meaning the same thing would drift.

**A/P aging does not claim to tie when filtered.** Unfiltered, it is checked
against the A/P control account like A/R is. Filtered to one kind it returns
`tiesToLedger: null` and the report says it is showing a subset, rather than
displaying a mismatch that is not a mismatch.

### Phase 5 — reports (2026-08-21)

**Retained earnings are computed, never posted.** The Balance Sheet takes the
Retained Earnings account's own balance — which only a migration entry ever
touches — and adds income less expenses for every posting dated before the
fiscal year containing the as-of date. The report shows both parts separately so
the figure can be checked. A test spans a fiscal-year boundary and asserts the
prior year's profit appears in retained earnings while the account itself holds
zero; without that test the bug is invisible in seed data that spans months.

**Aging reports check themselves against the ledger.** A/R and A/P aging are
built from open documents, because buckets need due dates the ledger does not
carry. Each report then compares its total to the control account balance and
says so when they differ, rather than presenting a figure nobody can tie out.
A/P filtered to one vendor kind reports `tiesToLedger: null` instead of a false
mismatch.

**Every report is a URL.** Date ranges and presets are plain GET forms, so a
report can be bookmarked, shared, or linked from a drill-down and come back the
same. Drill-down passes the report's own period through to the account detail.

**The seed tells a true story.** Building the Balance Sheet exposed a negative
Advances to Consultants balance: the fixture recovered a cash advance that had
never been paid out. The seed now posts the advance first, so the deduction line
clears it to zero — a fixture that models something impossible is worse than no
fixture.

### Phase 6 — time tracking (2026-08-21)

**Nothing hardcodes +8.** Asia/Manila has no daylight saving, which is the
simplification the spec points out, but every conversion goes through the IANA
zone via `date-fns-tz`. A test asserts 09:00 in New York maps to different UTC
instants in January and July, so the layer stays correct if a company ever runs
its clock somewhere that observes DST.

**The work day is where the shift started.** Grouping, daily totals and filters
all key on the local calendar date of `clockInAt`. A shift from 23:30 to 01:15
contributes all 105 minutes to the day it began and nothing to the next — its
minutes are never split across two days. Tested directly, and the seed contains
one so the grid shows it.

**An admin edit cannot be saved without a reason**, and the original clock-in
and clock-out are kept the first time a row is changed. A consultant can flag a
row but never change a recorded time.

**Auto-close stops the clock at the limit, not at "now".** A shift left running
is closed exactly `maxShiftHours` after it started and flagged for review — a
guess presented as a guess, rather than a plausible-looking finish time nobody
verified.

**The scheduler does not start itself on import.** `SCHEDULER_ENABLED=true`
turns it on, and the jobs are plain functions taking no scheduler state. Two app
instances would otherwise run every job twice, and Phase 8's recurring invoices
must not issue twice.

### Sales orders, sales-by-customer, consultant bills (2026-08-21)

Built to close the three gaps between the user's section description and what
existed. Section access itself was already in place.

**A sales order posts nothing, and the UI says so.** Confirming allocates a
number from its own `SO` sequence; converting creates a **draft** invoice and
links the two. A test asserts the P&L shows zero income after confirmation and
the invoiced amount only after the invoice is issued. The list shows a
"confirmed and not yet invoiced" total with a note that it is deliberately
absent from the P&L — agreed work is not revenue.

**One order becomes one invoice.** Partial invoicing is out of scope for the
MVP; the spec says so and the code refuses a second conversion rather than
silently creating two.

**Consultant bills are the same document as vendor bills.** An `Expense` with
`kind = BILL` against a `CONSULTANT` vendor, hitting the same A/P and settled by
the same `BillPayment`. Only the section differs, and the filtering is in the
query on both sides: the Vendors expenses list now explicitly excludes
consultant-owned bills, so the sections genuinely cannot see each other's
parties.

**Sales-by-customer excludes drafts and voids**, because neither is a sale, and
converts foreign-currency invoices at their own rate — the rate they sit in the
ledger at, not today's.

### Phase 7 — documents and email (2026-08-21)

**React-PDF, not headless Chrome.** SPEC §11 leaves the choice open and §13
notes that a Vercel deployment would need an external PDF service because
headless Chrome does not fit its runtime. Rendering with `@react-pdf/renderer`
removes that constraint entirely: no browser in the container, no separate
service, and the same code path in development and production. The cost is that
templates are React-PDF primitives rather than HTML, which for three documents
is a fair trade.

**One template for all three documents.** An invoice, a work order and a receipt
differ in their heading, fields and totals, not in their shape. They share
`DocumentPdf` and differ in the data handed to it, so branding and layout
changes land on all three at once.

**A draft work order's filename carries a short id.** `WorkOrder-DRAFT-a1b2c3-
abigail.pdf` rather than `WorkOrder-DRAFT-abigail.pdf`: two drafts for the same
consultant in one bulk email would otherwise produce the same attachment name
and one would silently vanish. Tested.

**Envelope encryption for refresh tokens.** A fresh data key encrypts the token
and the environment key encrypts the data key. Rotating the environment key
means re-wrapping short data keys rather than re-encrypting every secret, and
the environment key never directly touches a stored secret. Tampered ciphertext
throws rather than returning garbage — AES-GCM, authenticated.

**MIME is built by hand.** Gmail's API takes a base64url-encoded RFC 5322
message; a mailer library exists mostly to open SMTP connections, which this
never does. Non-ASCII subjects are RFC 2047 encoded so an accented name is not
mangled.

**Retry only what is worth retrying.** 429 and 5xx back off and retry up to
three times; a 4xx is recorded as failed immediately, because a rejected address
will not fix itself. A revoked grant flips the connection to "reconnect
required" so the UI can say so rather than failing silently on every send.

**`lastEmailedAt` is stamped only on success.** A failed send leaves the
document reading as not sent — otherwise the user believes a consultant received
something they never did.

### Phase 8a — Excel work-order import (2026-08-21)

**ExcelJS, not SheetJS.** SPEC §8.3 allows either. The `xlsx` package on npm is
stuck at 0.18.5 with open advisories because SheetJS moved distribution to their
own CDN; ExcelJS is current on the registry, reads both `.xlsx` and `.csv`, and
writes the template and reject files too.

**Grouping is per consultant, not per adjacent row.** A `Line No.` of 1 opens
that consultant's work order and 2, 3 … attach to it, with each consultant's
open group tracked separately — so a sheet that interleaves people still groups
correctly. A continuation with nothing to continue is a row error, a repeated
line number is a row error, and a gap is a warning that renumbers.

**A group that nets to zero or less is refused.** Deductions exceeding the work
are not a payable; that is money the consultant owes back, which is a
receivable. The error names the consultant and the amount.

**A negative line on an income-statement account gets a notice, not an error.**
Coding `Cash Advances` to `Consultant Fees` is legitimate and reduces reported
expense; coding it to an advances account clears the advance instead. The
importer does what the sheet says and says what it did.

**Dates are read in the format the user picks, never guessed.** `8/9/2026` is
ambiguous, so the upload screen asks. Real dates and Excel serials are read
directly. An unreadable date is an error rather than a silent default to today.

**A stated Amount is checked, not trusted.** More than a cent away from
quantity × rate and the row is rejected — a mismatch means the sheet disagrees
with itself, and picking a side silently would be worse than stopping.

**Re-validation happens at commit.** The staged rows are re-checked against the
current database rather than trusting what was computed at upload: a consultant
may have been created, or a mapping chosen, between the two steps.

**Undo exists but is narrow.** A whole batch can be removed while every work
order it made is still an untouched draft. Once one is approved or emailed,
undo refuses and points at handling those individually — deleting a posted
document is never the answer.

### Phase 8b — bulk work-order send (2026-08-21)

**Excluded consultants are recorded on the batch, not filtered out of it.** A
consultant with no address or marked not-to-be-emailed becomes a `SKIPPED` item
carrying the reason, so the results screen can say who got nothing and why. The
selection list greys them out for the same reason: silence is the failure mode
the user asked to avoid.

**Retry is keyed on the item, not the batch.** `EmailBatchItem` holds each
message's own state, so "retry failed only" re-queues exactly the failures.
Processing a batch twice is a no-op for anything already sent — verified by a
test that calls `processBatch` twice and asserts one log row.

**The email log keeps every attempt, so counts differ on purpose.** A batch of
three where one fails and is retried leaves four log rows and three sends. The
log is the record of what was attempted; the batch is the record of what got
through.

**Labels are derived from the documents inside `composeMessage`.** They were
originally passed in by the caller, and the send path passed none — so the
preview read "Work order WO1001" and the message that actually went out read
"Work order from …". Caught by sending a real batch rather than by the test,
which only checked for unresolved `{{`; the test now asserts the number is
present in the sent subject and body.

**Attachment size is checked before Gmail sees it.** One consultant with many
documents can exceed the 25 MB limit; that message fails with a clear reason
naming the size, rather than a rejection from Google.

## Gmail deployment shape — 2026-08-21

Answered by the user so the setup guide could be exact rather than branching:

| Question                     | Answer                                                  | What it settles                                                                                                                                                          |
| ---------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace or personal Gmail? | `bookkeepingpoint.com` is a **Google Workspace domain** | The consent screen is **Internal**: no verification review, no test-user list, and no seven-day refresh-token expiry. Only accounts in that domain can connect a mailbox |
| Where will it run?           | **Localhost for now**                                   | One redirect URI to register: `http://localhost:3000/api/email/google/callback`. The deployed one is added to the same client later                                      |

**The redirect URI is derived from the request, not from `NODE_ENV`.** Writing
the guide surfaced a real bug rather than a documentation gap: the authorize
call chose the scheme from `NODE_ENV` while the callback used `request.url`.
A production build over plain HTTP would ask for `https://localhost:3000/…`,
and a deployment behind a TLS proxy would have the token exchange disagree with
the authorize call. Both now use `requestOrigin`, which reads the forwarded
headers and falls back to HTTPS unless the host is loopback. Google compares
this string exactly, so one derivation is the only safe number of derivations.

**`npm run email:check` exists because the failure was invisible.** Configuration
lives across `.env` and the database (a connected mailbox is per company), so
"why did nothing send" had no single place to look. The script reports both, and
given an address sends through `sendEmail` — the same path the app uses, not a
parallel one that could pass while the app fails.

## Phase 9 — dashboard and polish (2026-08-21)

**Dashboard tiles are section-gated in the data layer, and absent rather than
zero.** A tile a user may not see returns `null`, and the page renders what it
is handed. A zero is a claim about the business: telling a vendors-only
bookkeeper that receivables are nil would be a false one, and telling them
nothing is the honest answer. The payables tile names which side it covers when
only one kind is visible, so a partial figure is not read as the whole.

**Every dashboard figure comes from the library its own report uses.** Reusing
`arAging`, `apAging` and `balancesByAccount` means a tile that disagrees with
its report is one bug in one place, not two implementations drifting apart. The
monthly trend is the exception — one grouped SQL scan instead of six
`balancesByAccount` calls, because it runs on every page load — and a test
cross-checks it against the P&L for the same months.

**No unmatched-bank-lines tile.** The spec lists one, but it counts rows from
the CSV bank import (§8.5), which is deferred. "0 unmatched" would read as
reconciled books rather than as a missing feature, so the tile waits for the
import.

**The full data export is owner-only, stricter than the Settings section around
it.** The archive crosses every section boundary in one file. Section access is
a wall, not a speed bump, so a vendors-only bookkeeper must not be able to pull
a customer record out of a zip. The refusal names that reason rather than
telling the reader to request a grant that would not help — `no-access` now
takes an explicit reason for cases where naming a section misdirects.

**`journal-lines.csv` is declared authoritative inside the export.** Every other
file in the archive is a document view over the ledger, and the README says so,
so a reader who trusts nothing else can add up the journal.

**Touch targets grow only under `pointer: coarse`.** 44px is right for a thumb
and wrong for a bookkeeper doing data entry all day. One media query on the
shared primitives rather than a phone-specific variant of each control.

**Playwright earns its place by testing what Vitest cannot.** The spec asks for
it (§13) and it had not been added. It covers exactly the questions a browser
answers: does the keystroke land where the typist expects, does the page fit a
phone. Everything provable without a browser stays in Vitest.

### Bugs this phase surfaced

Worth recording because of how they were found, not what they were:

- **The Tab-adds-a-row shortcut never worked.** Both editors appended the row
  after the browser had moved focus, so the caret landed on the delete button.
  It had been in the code, and in the spec, since Phase 3 — and no test could
  have caught it without a real browser.
- **Five pages threw on every render.** `const fail = (msg) => redirect(...)`
  next to a server action is captured by that action, and a captured function
  cannot be serialised. Each page still answered 200 and the error only reached
  the server log, which is exactly why it survived five screens. Found because
  the Playwright output surfaced the log.
- **"Ábigail & Co" exported as `bigail-co`.** The slug stripped the accented
  letter instead of folding it, because `[^a-z0-9]` does not match `á`. Caught
  by giving the test fixture a name with an accent in it.
- **Ten screens scrolled sideways on a phone**, all from bare tables with no
  scroll container, plus a Card that would not shrink below its widest child.

## One bill payments register, and aging that means what it says — 2026-08-21

**Paying a consultant and paying a regular vendor are one screen, scoped by
vendor kind.** The user's framing, and the right one: the act is identical, so
what varies is who may see which rows. A membership holding one section is
pinned to that kind whatever the URL says; only a membership holding both gets
a filter. This is the same rule the A/P aging report already followed.

**The register records as well as lists.** One bank transfer usually settles
several documents, so the screen shows everything a payee is owed on — work
orders and bills together — and pays them in one action. The service already
supported multiple applications; nothing had used it.

**A payment could settle another vendor's document.** `loadDocument` scoped an
application by company but never by vendor. The consequences were worse than
they looked: the document went to PAID, and the A/P debit took the *payer* as
its party while the original credit kept the real creditor — so the control
account still netted to zero and the aging total still tied, while per vendor
the ledger was wrong in both directions. It was also a section hole, since a
vendors-only user could have settled a consultant's work order by naming its
id. Applications must now belong to the vendor being paid.

**A/P aging compares per vendor, not only in total.** Two equal and opposite
errors cancel in a total, which is exactly how the above stayed invisible.
Comparing each party's ledger balance against their open documents is what
surfaces it, and the report names the vendors that disagree. The check paid for
itself immediately by catching a seed that post-dated a payment nine days into
the future.

**Aging is now genuinely as at its date.** Both reports read each document's
*current* balance, so "A/P as at 31 July" answered "what is open today" — a
document settled in August looked settled in July, and any report for a closed
period disagreed with the ledger for that period. Balances are now built from
the applications that had actually landed by the date.

Two details decide correctness, and both are accounting dates rather than
wall-clock ones. `reversedAt` and `voidedAt` record when someone clicked; the
reversing entry carries the date the books use. Taking the timestamps would
misfile anything reversed in one period for another — precisely the case a
historical aging exists to show. Status cannot be the filter either: a PAID
invoice was still owed before its payment, and a voided one before its void.

The assertion that matters is the tie-out to the control account *at the same
past date*, which is what an accountant does at year end. Six tests cover it,
and all six fail against the previous implementation.

## Recurring invoices — 2026-08-21

**Drafts by default, sending opt-in per template.** The spec asks for this and
it is right: a wrong draft is a nuisance, while an invoice that posts revenue
*and* reaches the customer with nobody having read it is a different kind of
mistake. The screen says as much where the choice is made.

**Idempotency is a unique constraint, not a check.** `(templateId,
scheduledDate)` is claimed as the first act of the transaction that creates the
invoice, so two overlapping runs cannot both pass a "has this run?" test and
both write. A test runs three generations concurrently and asserts one invoice;
the check-then-write version of this passes sequentially and fails there.

**Catch-up generates one invoice per missed period, not one lump.** A template
that has not run since June owes June, July and August separately, because each
of those periods happened. Capped, so a misconfigured start date cannot
generate hundreds.

**The schedule is anchored differently by cadence.** Monthly and longer are
anchored to a day of the month and clamped into short months — "the 31st" is
28 February and then *31 March*, not 28 every month thereafter. Weekly and
fortnightly are anchored to the start date, so a fortnightly schedule keeps its
own two-week rhythm rather than sliding toward month boundaries.

**"Run now" catches up; it does not pull the future forward.** Found by
clicking it twice in a browser: the first run advances `nextRunDate`, so the
second was generating *next month* on the 21st. It now refuses anything not yet
due and says when the next one falls.

**The job is hourly, not daily.** "06:00" means 06:00 in each company's own
operating zone, and those do not share an hour. The job wakes hourly, decides
per company whether it is past six there, and relies on idempotency to make the
repetition free.

**Drafts now carry their totals.** Generated drafts read `0.00` on the invoice
list until issued, because totals were only computed on issue — a month of
retainer drafts would have been a column of zeroes. Fixed for the manual
draft path too, which had the same wart.

## Bank import, and what volume actually broke — 2026-08-21

**The three match outcomes are one enum-like decision, and the flag that
matters is "did this match cause the entry".** A line that *found* an existing
entry and a line that *wrote* one both end up pointing at exactly one entry;
only the second has anything to undo. Getting that wrong once — I marked a
settled line as having created nothing — would have let unmatching orphan a
payment it had just created.

**Dedupe is a hash of (bank account, date, amount, description).** Not the file
and not the row position: banks re-issue statements with different orders and
names, and the overlap that matters is with the *last* statement.

**Debit is negative.** Statements print money out unsigned in a debit column;
taking it as written flips every payment into a receipt.

### What six years of data actually broke

Measured rather than guessed, on 10,084 invoices, 7,563 work orders, 17,661
journal entries and 25,920 bank lines:

| Screen | Before | After |
|---|---|---|
| A/R aging | 13.2s, 4.3 MB | 0.28s, 55 KB |
| A/P aging | 9.5s, 3.2 MB | 0.30s, 59 KB |
| Invoices | 0.9s, capped at 200 silently | 0.49s, paged, states the total |
| Bank matching | 1.4s, capped at 200 | 0.91s, paged |

Two separate faults, and the first fix alone changed nothing:

**The aging reports loaded every document ever issued.** That is what "still
open on this date" needs, and hydrating ten thousand invoices with their
payments is the cost. Now one grouped query per side returns only the documents
actually open, with the three date rules — payment dated on or before, reversal
dated after, void dated after — expressed in SQL. The dashboard, which uses the
same function, went from 1.7s to 0.37s.

**The pages then rendered every one of them.** 4.3 MB of HTML with ten thousand
invoice links crammed into five table cells. The aging report's job is the
buckets; naming five documents per party with a link to the rest is both faster
and more readable. That was the fix that moved the number.

**Silent truncation is worse than slowness on a financial screen.** Every list
took the first 100–200 rows and said nothing, so the figures on the page were
true and the impression they gave was false. Lists now state their total — "1–100
of 10,084 invoices" — and page through it.

## The books start empty — 2026-08-21

The original answer to "existing data" was to migrate spreadsheet history, and
§4.4 was written around it: open items as real documents, closed periods as
summarised entries, opening balances underneath. Asked again with the app
finished, the user confirmed there is **no history to bring in**.

So §4.4 is not built. It stays in the spec as the design to follow if history
ever turns up, clearly marked as unimplemented rather than quietly deleted — a
spec that silently loses a section is worse than one that says what happened to
it. Acceptance criterion 16 is retired rather than left failing: it describes
work that is not needed, and carrying it as "unmet" would misreport the state
of the app.

Starting a company is what already exists — a chosen start date and opening
balances through the single `OPENING_BALANCE` entry (§4.3), balancing to
Opening Balance Equity.

## Deviations from the spec

None yet. Anything built differently from SPEC.md gets a dated entry here
explaining what and why.
