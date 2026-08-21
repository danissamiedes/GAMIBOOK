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

## Deviations from the spec

None yet. Anything built differently from SPEC.md gets a dated entry here
explaining what and why.
