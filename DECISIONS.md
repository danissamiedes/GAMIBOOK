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

## Outstanding inputs

Neither blocks the phase it sits in, but both block go-live:

- **The historical spreadsheet and the books' start date** (§16.4, §4.4). The
  migration parser cannot be written until the file exists. Layers 1 and 3 of
  §4.4 get built against the seed fixture in the meantime.
- **The work order spreadsheet the user already uses** (§16.7, §8.3). The
  provisional column set ships behind a single column map so adapting it is a
  data change, not a rewrite.

## Deviations from the spec

None yet. Anything built differently from SPEC.md gets a dated entry here
explaining what and why.
