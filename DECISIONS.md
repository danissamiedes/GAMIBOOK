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

## There was no way in — 2026-08-21

The user deployed to Vercel and got Auth.js's *"There was a problem with the
server configuration"* from the credentials callback. That error is generic: it
means `AUTH_SECRET` is unset, or `authorize()` threw — and `authorize()` calls
Prisma, so an unset, unreachable or unmigrated `DATABASE_URL` produces the same
message. Vercel reads neither your `.env` nor your intentions, and provisions no
database.

Chasing that down surfaced a worse problem. **A fresh deployment had no way to
create its first user.** The only paths in were `npm run seed` — the development
fixture, with two demo companies and a shared password — and an invitation,
which requires an owner to already exist. The app was, on an empty database,
unusable by design and nobody had noticed because development always started
from the seed.

`npm run bootstrap` is the missing piece: one organization, one owner, one empty
company with the default chart of accounts, and nothing else. It refuses to run
if any user exists, so it cannot quietly add a second owner to live books. The
password is prompted with echo suppressed rather than read from an environment
variable, because an env var survives in shell history, in `docker inspect`, and
in whatever the process manager logs. Every answer *can* come from the
environment for unattended installs, but that is the fallback, not the path.

`setupCompletedAt` is deliberately left null, so the first sign-in lands on the
setup wizard. The base-currency decision is permanent, and it should be made on
the screen that says so, not guessed by a shell script.

**The single-VPS story got a production compose file of its own**
(`docker-compose.prod.yml`), separate from the development one rather than an
overlay on it, because the differences are the kind you want to read in one
place: Postgres is not published to the host, no secret has a default, Caddy
terminates TLS, and `SCHEDULER_ENABLED` defaults to true. That last one was a
live bug — the README said recurring invoices do not generate without it and the
compose file did not pass it at all, so a by-the-book deployment would have
silently never generated one.

Vercel is documented as possible but not chosen, with the four things that break
named — local disk storage, the in-process scheduler, Prisma connection counts,
and in-memory login rate limiting. All four are consequences of the app assuming
one long-lived process, which is the right assumption for the size of business
this is for.

## Vercel is a supported target now — 2026-08-21

The user asked for Vercel specifically, having seen the case for a VPS. Four
things assumed a server that stays alive between requests, and each is now
handled rather than warned about.

**The scheduler had never run anywhere.** `startScheduler()` was written in
Phase 7 and called from nothing — no `instrumentation.ts`, no import, nothing.
Recurring invoices and the stale-shift auto-close have therefore never fired on
their own in any deployment, VPS included. That is now two mechanisms over one
job list: `instrumentation.ts` starts the timers where a process persists, and
`/api/cron` runs the same `JOBS` array when something outside knocks. The route
needed adding to the middleware's public prefixes — a scheduler arrives with no
session by definition — and authenticates with `CRON_SECRET` compared through a
SHA-256 digest so the check is constant-time whatever the lengths. The secret is
deliberately not accepted in the query string: URLs end up in access logs,
browser history and referrer headers.

Every job was already idempotent, which is what makes one shared schedule
workable — a late call delays work rather than losing it. Worth knowing: Vercel's
Hobby plan runs cron once a day, which is fine for recurring invoices and not
fine for closing a forgotten shift, so the README names the external-pinger
alternative rather than pretending hourly is what you get.

**Rate limiting moved into Postgres.** In memory it was correct for one node and
close to meaningless on serverless, where every cold start hands the caller a
fresh allowance. It is now one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
so that concurrent attempts cannot each read the same count and each conclude
they are under the limit — there is a test that fires ten at once against a
limit of five and expects exactly five through. The interface gained an `await`
and nothing else.

**Local disk storage is now refused on serverless rather than tolerated.** The
tempting workaround is `/tmp`, and it is the worst option available: every write
succeeds, and the receipts and imported bank statements are gone by the next
request with no error anywhere. A deployment that will not start is a much
smaller problem than books missing their source documents, so `storage()` throws
when `VERCEL` or `AWS_LAMBDA_FUNCTION_NAME` is set and the driver is `local`.

**Prisma needed two connection strings.** `DATABASE_URL` points at a pooler
there; migrations need a session the pooler will not hold, so `directUrl` takes
`DIRECT_DATABASE_URL`. Prisma treats a declared `directUrl` with a missing
variable as a schema error rather than falling back, so it must always be set —
on a VPS, to the same value. That bit the test harness first: `loadTestEnv()`
overrode `DATABASE_URL` only, which would have pointed `prisma migrate` at the
*development* database during a test run.

The single-VPS path stays the recommended one and is unchanged in substance. It
is one service instead of three, and the backup is a file you own rather than
whatever a free tier happens to retain.

## Three services, and what they cost — 2026-08-21

The user settled on Supabase, GitHub and Vercel, and asked what could not run on
those alone. The answer turned out to be: nothing, but four limits are real and
two of them needed building rather than documenting.

**Supabase covers both halves of what Vercel lacks.** Postgres with a transaction
pooler and a direct connection, and Storage behind an S3-compatible endpoint.
The storage adapter only ever issues PutObject, GetObject, HeadObject,
DeleteObject and ListObjectsV2, all of which that endpoint serves, so no adapter
work was needed — the driver switch is four environment variables.

**The upload limit was a promise the app could not keep.** `MAX_IMPORT_BYTES` was
10 MB, and Vercel rejects a request body over 4.5 MB before any application code
runs. A user picking an 8 MB bank statement would have waited and then been shown
a platform error rather than ours. It is now a function of the environment, and
the hints and messages read from the same place, so the number on the screen is
the number that applies.

**GitHub Actions is the scheduler, not Vercel Cron.** Hobby runs cron once a day,
which is fine for a recurring invoice and not for closing a forgotten shift. The
workflow runs hourly and doubles as the keep-alive that stops a free Supabase
project pausing after a week. Hourly rather than every fifteen minutes for a
mundane reason: Actions bills each run rounded up to a whole minute, so quarter-
hourly is about 2,900 minutes a month against a 2,000-minute free tier. That is
the sort of limit that is discovered in the second month, so it is written down.

**Nothing was backing up the books.** Supabase's free plan takes no downloadable
automated backup, so a nightly workflow dumps the direct connection, proves the
archive reads back with `pg_restore --list`, and keeps thirty days in a separate
bucket. It refuses to upload a dump under 20 KB — a half-connected run must not
quietly replace a good backup with an empty one. Writing the retention step
surfaced its own bug: `grep` exits non-zero on no matches, so with `pipefail` the
first ever run would have failed for having nothing to tidy.

The remaining limits are stated rather than worked around: downloads share the
4.5 MB ceiling, so a full export of several years of books would fail and should
be taken from a restored local copy; Actions schedules are best-effort and run
late under load; and emailing invoices still needs a Google Cloud OAuth client,
which is a fourth thing to configure even when it is not a fourth service.

## Both connection strings come from the pooler — 2026-08-21

The obvious reading of "pooled for requests, direct for migrations" sends you to
Supabase's **Direct connection** for `DIRECT_DATABASE_URL`, and it would have
broken the nightly backup on its first run. Supabase serves that host over IPv6
only unless you buy the IPv4 add-on, and GitHub Actions runners have no IPv6.

The **session pooler** (port 5432) is the right answer for both jobs that need a
held session — migrations and `pg_dump`. It is reachable over IPv4 and, unlike
the transaction pooler on 6543, holds the session the migration engine's advisory
locks depend on. So both strings come from the same pooler host and differ only
in port.

The backup workflow now rejects a `SUPABASE_DB_URL` on port 6543 up front, with
the reason, rather than letting it surface as a confusing `pg_dump` failure at
two in the morning.

## Vercel sets no Host header — 2026-08-21

An invitation issued from the live deployment produced a link to
`localhost:3000`. The users page was building the URL from
`headers().get("host")` with the scheme guessed from `NODE_ENV`, rather than
from `requestOrigin()` — the helper written for exactly this and already used by
both Gmail OAuth paths.

The mechanism is worth recording because it is not the obvious one: Vercel does
not set a plain `Host` header at all, only `x-forwarded-host`. So the lookup did
not return the wrong value, it returned nothing, and fell through to the
`"localhost:3000"` literal sitting behind it. A duplicated implementation and a
silent default hid it until someone clicked a real invitation.

Two changes. The page now uses the helper. And the helper's own last resort is
no longer localhost: it tries `AUTH_URL`, then `VERCEL_URL`, before that
literal. A host answering on neither header is unusual, but guessing localhost
there yields a link that is confidently wrong rather than obviously broken, and
these links are single-use and expire in seven days — a bad one wastes the
invitation, not just a click.

The general lesson, which the OAuth work in Phase 8 already taught once: the
origin a browser used is knowable from the request, and every attempt to infer
it from `NODE_ENV` or a bare `Host` has been wrong somewhere.

## "Wrong email or password" was hiding two other things — 2026-08-21

Sign-in on the deployed app reported a wrong password for an email the user knew
was right. The login page caught every failure and redirected to `?error=1`,
which rendered one fixed sentence. Three quite different situations arrived
there: authorize() returning null (a genuine mismatch), the rate limiter
throwing after ten attempts in fifteen minutes, and anything else throwing —
including the database being unreachable.

Both of the hidden ones are actively harmful as "wrong password". Told their
password is wrong, a throttled person tries again, and each attempt extends the
lockout they are already in. An outage looks like a typo, so nobody reports it
and it is diagnosed as user error.

Distinguishing them leaks nothing. The login limiter is keyed and counted
*before* the user lookup, so hitting it says nothing about whether the address
exists; an outage is not about the account at all. Which password was wrong
still goes unsaid.

`RateLimitError` carries the retry window, `loginErrorCode()` walks Auth.js's
wrapping to classify what happened, and the three messages live in one map.
Auth.js nests the original error at `cause.err` — read out of
`@auth/core/errors.js` rather than guessed, since its own classes cannot be
imported into the test environment.

The password-reset screen had the same shape of problem: a throttled request
redirected to `?sent=1`, indistinguishable from a real one, leaving someone
waiting for a link that was never created. That limiter is per IP rather than
per address, so saying so reveals nothing either.

All three paths were checked against a running production build: a wrong
password, an eleventh attempt, and a server pointed at a port with nothing on it.

## A total on the bill payment form — 2026-08-22

The payment *is* the sum of the amounts applied: the server does not accept an
amount typed separately, it adds up the lines. So the one figure that matters —
what will leave the bank — was the only one not on the screen. Now it is, live
as you type, with a count of how many documents are included.

The total has to agree exactly with what gets recorded, or it is worse than
nothing. Rather than reimplement the parsing rules in the browser, the text
handling moved out of `parseMoney` into `money-text.ts`, which has no Decimal or
Prisma dependency: the server wraps its output in a Decimal, the browser sums it
in whole cents. One set of rules, and a test that holds the two to the same
table of inputs.

Cents rather than floats, for the obvious reason: 0.1 + 0.2 is not 0.3, and a
payment total off by a hundredth is a wrong number shown to someone approving
money. Text with more than two decimals is treated as unreadable rather than
rounded — rounding it would show a total that quietly differs from the posting.

Fixing this surfaced a layout bug in the same rows. `Input` bakes in `w-full`,
and the page passed `w-28` alongside it; two width utilities fighting over
source order, with `w-full` winning. The amount box took the whole row and
squeezed the label into one word per line — visible in the screenshot that
prompted the request. The row is now a grid with an explicit column for the
amount, which does not depend on which utility happens to sort later.

## The posting was not too big, the database was too far — 2026-08-22

Recording a bill payment failed on the deployment while succeeding locally
against three different databases. The first hypothesis here was the pooler:
every write runs inside a Prisma interactive transaction, and a transaction-mode
pooler does not hold one server connection for the life of one, so it fit. It
was wrong, and the runtime log said so in one line:

```
P2028  Transaction already closed ... timeout was 5000 ms, however 5153 ms passed
```

Prisma's interactive-transaction default is 5 seconds, which assumes the
database is nearby. The functions were running in Cleveland and the database is
in Singapore. A posting makes a couple of dozen queries inside one transaction,
each a separate round trip, so most of those five seconds were spent on the
network rather than on work. It failed by 153 milliseconds.

Two changes, and only the second is the actual fix. The ceiling moved to 20
seconds (with the app segment's `maxDuration` at 60, so the transaction times
out and rolls back cleanly rather than the platform killing the function
mid-write). And the region: functions belong in the database's region, which
takes the same posting from about five seconds to under one.

The lesson is about diagnosis rather than latency. Three local reproductions all
passed, which was good evidence that the code was fine and no evidence at all
about what was actually wrong; the elimination could have continued for a long
time. What ended it was the error digest on the failure screen, added an hour
earlier for exactly this, and one look at the server log. Reach for the log
sooner than feels necessary.

The pooler advice stands regardless — session mode on 5432 with
`connection_limit=1` is right for an app whose every write is an interactive
transaction — but it was not what broke this.

## A total on the bill payment form — 2026-08-22

The payment *is* the sum of the amounts applied: the server does not accept an
amount typed separately, it adds up the lines. So the one figure that matters —
what will leave the bank — was the only one not on the screen. Now it is, live
as you type, with a count of how many documents are included.

The total has to agree exactly with what gets recorded, or it is worse than
nothing. Rather than reimplement the parsing rules in the browser, the text
handling moved out of `parseMoney` into `money-text.ts`, which has no Decimal or
Prisma dependency: the server wraps its output in a Decimal, the browser sums it
in whole cents. One set of rules, and a test that holds the two to the same
table of inputs.

Cents rather than floats, for the obvious reason: 0.1 + 0.2 is not 0.3, and a
payment total off by a hundredth is a wrong number shown to someone approving
money. Text with more than two decimals is treated as unreadable rather than
rounded — rounding it would show a total that quietly differs from the posting.

Fixing this surfaced a layout bug in the same rows. `Input` bakes in `w-full`,
and the page passed `w-28` alongside it; two width utilities fighting over
source order, with `w-full` winning. The amount box took the whole row and
squeezed the label into one word per line — visible in the screenshot that
prompted the request. The row is now a grid with an explicit column for the
amount, which does not depend on which utility happens to sort later.

## Session pooling, not transaction pooling — 2026-08-22

Recording a bill payment on the deployment failed with the app's catch-all error
page while the same action succeeded locally, against both a seeded database and
one created by the SQL bootstrap. What differs is the connection.

Every write path in this app runs inside a Prisma *interactive* transaction —
`postJournalEntry` and the twelve modules that call it. A transaction-mode
pooler does not hold one server connection for the life of a transaction, which
is exactly what an interactive transaction requires. Reads are unaffected, so
the app looks healthy until something posts, and then fails intermittently
depending on whether the pooler happened to keep the connection.

The earlier advice here — transaction pooler on 6543 for `DATABASE_URL` — is the
right default for a typical Next.js app and the wrong one for a double-entry
ledger, where every meaningful action is a transaction. Both variables now use
the session pooler on 5432, with `connection_limit=1` on the app's so that a
burst of serverless instances does not exhaust the database.

The error page was making this harder to diagnose than it needed to be. It
offered "ask an owner for access" for every error that reached it, which sends
people to check their permissions when the cause is a database. It now says
plainly that nothing was saved and that this is a fault in the app, and prints
the Next.js error digest so a report can be matched to the stack trace in the
server log.

## Transaction pooling, and a lockout caused by getting that wrong — 2026-08-22

Diagnosing the P2028 timeout, the first theory here was that Prisma interactive
transactions cannot run through a transaction-mode pooler, and `DATABASE_URL`
was moved to the session pooler on that basis. Both halves were wrong, and the
second half took the deployment down.

The reasoning was wrong: a transaction is exactly the unit a transaction-mode
pooler pins a server connection for, so `BEGIN…COMMIT` is held throughout.
Interactive transactions are fine there. What such a pooler will not hold is a
session *between* transactions — which is why prepared statements need
`pgbouncer=true`, and why migrations use the session pooler.

The consequence was worse than the theory. Supabase's session mode allows 15
clients on the free tier, and Prisma opens `(cpus × 2) + 1` per instance by
default. A few serverless instances exhausted it, and because the login rate
limiter is a database query, `EMAXCONNSESSION` locked everyone out of the app
entirely — not just writes.

The settled configuration: transaction pooler on 6543 with
`pgbouncer=true&connection_limit=1` for the app, session pooler on 5432 for
migrations. `connection_limit=1` is not optional on serverless; it is what keeps
instance count from multiplying into connection count.

Two things worth keeping from this. The actual bug was the 5-second transaction
timeout, found in one line of the runtime log after three local reproductions
had proved only that the code was fine — the log should have come first. And a
config change made on an unverified theory reached production before the theory
was tested; the theory was cheap to check and the outage was not.

## The navigation is grouped — 2026-08-22

Thirty links wrapped across three rows is not navigation, it is a list, and it
was the weakest thing in the app to look at. The grouping is the customer's own
and follows how the work is organised rather than how the routes are: Customers,
Consultants, Vendors, Banking, Reporting, Other, with Dashboard staying a plain
link because it has nothing under it.

The rule while regrouping was that nothing may become visible or invisible as a
side effect. Every item kept exactly the section check it had in the flat row,
which is why Bill payments and A/P Aging sit under Vendors but are gated on
CONSULTANTS *or* VENDORS — a consultant's work order and a supplier's bill are
settled the same way (SPEC §6). Empty groups are dropped, so a bookkeeper with
one section gets two menus rather than seven, five of which open onto nothing.

Two details worth keeping. The open menu is stored with the path it was opened
on and closed by derivation, not by an effect on pathname — an effect fires
after the new page has painted, so the menu visibly hangs over the page you just
asked for. And the current-page match takes the longest matching href, so
`/invoices/recurring` marks Recurring rather than Invoices; both are prefixes of
the path and only one of them is the page.

The mobile end-to-end test changed with it. It asserted a *visible* Invoices
link, which a closed menu breaks; it now asserts the link is hidden at rest,
reachable in one tap, and closed again after navigating. Reachable was always
the requirement — visible-at-rest was the old shape's way of meeting it.

## Blue, grey and white — and the product has a name — 2026-08-22

The scheme is defined once, as `brand` in globals.css, rather than spread across
the sixty files that use a colour. Everything interactive takes it — the primary
button, focus rings, links, the current page in the navigation — while structure
stays slate, a grey that leans blue and so sits with the accent rather than
against it, on white.

**Red, amber and green are deliberately untouched.** On these screens they are
not decoration: red is overdue and negative, amber is a warning that needs
acting on, green is money coming in. A palette that recoloured them would be
taking meaning out of the figures to match a swatch. If the three-colour rule is
meant strictly, that is a decision to make knowingly.

One thing the recolouring fixed by accident: every link in the app is a bare
`underline`, inheriting body colour, so links read as emphasis rather than as
somewhere to go. They are brand-coloured now, from one rule, without touching
fifty-one call sites.

**The product name moved into `lib/brand.ts`.** It was a literal in forty-five
page titles and four headings, so renaming it to GAMIBOOK by hand would have
been a find-and-replace that drifts the first time one is missed. `pageTitle()`
builds the tab title so the separator and word order stay consistent too. This
is the *product* name and not the company's — the company name lives on the
Company record and is what a customer sees on an invoice.

Worth recording because it nearly shipped broken: the script that added the
import inserted it after "the last line starting with `import `", which lands in
the middle of a multi-line import and produces a syntax error. Typecheck caught
it in one file; the repair inserts after the directive prologue instead, which
is always valid. A codemod needs the same suspicion as the code it edits.

## A misconfiguration should say which setting — 2026-08-22

Emailing a work order failed with the app's generic error page, and downloading
the same work order's PDF returned a bare HTTP 500. Both go through
`cachedPdf`, which renders the document and files it in storage; storage was
never configured on the deployment, so `storage()` threw — exactly as designed,
since a serverless filesystem would accept a receipt and lose it.

The guard was right and the reporting was wrong. The message named the setting
and how to fix it, and it went only to the server log. Diagnosing it took a
video, a log hunt and a round of elimination for something the app knew the
instant it happened.

Configuration failures are now `ConfigurationError`, which is a different
audience from the other errors in that file: not a person doing something they
may not, but an operator who has to change a setting. Nothing in the message is
secret — it names `STORAGE_DRIVER` and the variables to set — so the download
route answers 503 with it as plain text, and the two email actions report it on
the page they came from.

Worth noticing: the failure was in the *attachment*, not the email. Dry run
short-circuits before any network call, so Gmail was never involved, and the
one thing the screen said with confidence — that this was about emailing — was
the one thing it had wrong.

## Deviations from the spec

None yet. Anything built differently from SPEC.md gets a dated entry here
explaining what and why.

## A storage failure names the settings to check

The download route already turned a `ConfigurationError` into a 503 with the
message. That only covered one case: `STORAGE_DRIVER=local` on a serverless
host. A deployment with `STORAGE_DRIVER=s3` and a wrong bucket, endpoint or key
pair got past the factory and failed inside the driver, which is a bare 500
again — the same dead end, one step later.

`withStorage()` wraps every storage call in the PDF path and the two upload
screens and re-labels a driver failure as `StorageUnavailableError`, a
`ConfigurationError` carrying what the driver said. The existing catch sites
pick it up unchanged, so the operator reads "File storage rejected the upload …
The storage service said: The specified bucket does not exist" instead of
opening the runtime log.

The logo upload and the bank-statement upload had no handling at all and would
have hit the same wall on this deployment; both now report it on the screen.
