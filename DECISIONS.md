# DECISIONS.md

Choices made while building Ledger, and why. Anything the spec left to judgment
that turned out to matter belongs here.

## Answered by the user — 2026-08-20

The eight open questions in SPEC.md §16 were put to the user and answered. The
answers are recorded in §16 itself; this is the short form, plus what each one
changed in the spec.

| # | Question | Answer | Changed |
|---|---|---|---|
| 1 | Base currency | **PHP**, clients invoiced in PHP **or USD** | §5 rewritten: FX is live on the receivables side, dormant on payables. Seed gains a USD invoice in the PHP company |
| 2 | Sales tax / VAT | None charged; build `TaxRate` and leave it unused | No change — this was the spec default |
| 3 | Consultant classification | Contractors, no withholding | No change — spec default |
| 4 | Existing data | **Migrate the spreadsheet history**, not just opening balances | New §4.4; Phase 8b extended; acceptance criterion 13 added |
| 5 | Fiscal year | January start | No change — spec default |
| 6 | Approval flow | No separate approver | No change — spec default |
| 7 | Excel import layout | **Match the user's existing spreadsheet** | §8.3 column table marked provisional; columns must live in one map driving template + parser |
| 8 | Bulk send grouping | One email per work order | No change — spec default; combine toggle still built |

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

- **The historical spreadsheet and the books' start date** (§16.4, §4.4). The
  migration parser cannot be written until the file exists. Layers 1 and 3 of
  §4.4 get built against the seed fixture in the meantime.
- ~~The work order spreadsheet~~ — received 2026-08-21, see above.

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

| Question | Answer |
|---|---|
| One vendor list or two tables? | **One `Vendor` table with `kind` = CONSULTANT \| REGULAR** |
| How should sections work? | **Per-user grants on top of the role**, enforced in nav, route and data layer |
| What is a Sales Order? | **Non-posting; converts to a draft invoice.** Revenue is recognised only on issue |
| What can the Vendors section reach? | Bills and payments, **plus direct expense entry** |

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

## Deviations from the spec

None yet. Anything built differently from SPEC.md gets a dated entry here
explaining what and why.
