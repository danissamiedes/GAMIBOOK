import Link from "next/link";
import { APP_NAME } from "@/lib/brand";
import { PLANS, CONTACT_EMAIL } from "./plans";
import { ContactForm } from "./contact-form";

/**
 * The public landing page (gamibook.com, signed out).
 *
 * Structure follows the BookkeepingPoint site the user supplied as a
 * reference — sticky nav, split hero, capability strip, feature grid, a dark
 * "why" band, four pricing tiers, testimonials, contact, footer — but every
 * word is about this product rather than a bookkeeping service. Two deliberate
 * departures from the reference, both because copying them would be a false
 * claim:
 *
 *   - No QuickBooks/Xero/FreshBooks logo strip. Those certify a *practitioner*,
 *     not this software, and putting them under a product name reads as an
 *     integration or an endorsement that does not exist. The strip says what
 *     the app actually does instead.
 *   - No testimonials are written here. The markup is ready and the quotes are
 *     visibly blank, because inventing a customer quote is inventing a
 *     customer. Fill them in from real clients, or delete the section.
 *
 * Prices live in ./plans so the numbers can be changed without reading JSX.
 */

function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 text-center text-xs font-semibold uppercase tracking-[0.12em] text-brand-600 dark:text-brand-400">
      {children}
    </p>
  );
}

function SectionHeading({
  children,
  sub,
}: {
  children: React.ReactNode;
  sub?: string;
}) {
  return (
    <>
      <h2 className="text-center text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl dark:text-white">
        {children}
      </h2>
      {sub ? (
        <p className="mx-auto mt-3 max-w-2xl text-center text-slate-600 dark:text-slate-400">
          {sub}
        </p>
      ) : null}
    </>
  );
}

function Check() {
  return (
    <svg
      viewBox="0 0 20 20"
      aria-hidden="true"
      className="mt-0.5 size-4 shrink-0 text-brand-600 dark:text-brand-400"
      fill="currentColor"
    >
      <path d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0Z" />
    </svg>
  );
}

/** Feature-card icons. Inline so the page pulls in no icon library. */
const ICONS: Record<string, React.ReactNode> = {
  invoice: (
    <path d="M6 2h9l3 3v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm2 6h8M8 12h8M8 16h4" />
  ),
  workOrder: <path d="M4 5h16M4 10h16M4 15h10M17 14l2 2 3-3" />,
  clock: <path d="M12 6v6l4 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />,
  bill: <path d="M4 4h16v14l-3-2-3 2-3-2-3 2-2-1.5V4Zm4 5h8M8 13h5" />,
  bank: <path d="M3 9 12 4l9 5M5 10v7m5-7v7m5-7v7m5-7v7M3 20h18" />,
  report: <path d="M4 20V10m5 10V4m5 16v-7m5 7V8" />,
};

function FeatureIcon({ name }: { name: keyof typeof ICONS }) {
  return (
    <span className="mb-4 inline-flex size-10 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-950 dark:text-brand-400">
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        className="size-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {ICONS[name]}
      </svg>
    </span>
  );
}

const NAV = [
  { href: "#features", label: "Features" },
  { href: "#why", label: `Why ${APP_NAME}` },
  { href: "#pricing", label: "Pricing" },
  { href: "#testimonials", label: "Clients" },
  { href: "#contact", label: "Contact" },
];

/** The hero's right-hand card: the shape of a working week, in four steps. */
const HOW_IT_WORKS = [
  {
    title: "Track",
    body: "Consultants clock in and out. Their hours become work orders you can check before a peso moves.",
  },
  {
    title: "Bill",
    body: "Invoices to customers, bills from vendors, payments matched against both.",
  },
  {
    title: "Reconcile",
    body: "Import the bank statement and match it line by line against what the books already say.",
  },
  {
    title: "Report",
    body: "Profit & loss, balance sheet and trial balance for any period, with every figure drillable to its journal entry.",
  },
];

const FEATURES = [
  {
    icon: "invoice" as const,
    title: "Invoices & receivables",
    body: "Raise invoices in any currency, email them from your own Gmail, and watch what is still owed. Payments settle against the invoice and post themselves.",
  },
  {
    icon: "workOrder" as const,
    title: "Consultant work orders",
    body: "Approve what a consultant has earned, send the lot in one pass, and pay many work orders in a single run instead of opening each one.",
  },
  {
    icon: "clock" as const,
    title: "Time clock",
    body: "Consultants clock in from their own login and see nothing else. Shifts land on the day they started in your timezone, not UTC's.",
  },
  {
    icon: "bill" as const,
    title: "Bills & expenses",
    body: "Vendor bills, direct expenses and recurring templates that generate themselves. Attach the receipt to the record that carries it.",
  },
  {
    icon: "bank" as const,
    title: "Bank reconciliation",
    body: "Import a statement in your bank's own layout. GAMIBOOK proposes the match, flags the duplicates and leaves the judgement to you.",
  },
  {
    icon: "report" as const,
    title: "Reports & period close",
    body: "P&L by month with gross margin, balance sheet, trial balance, general ledger. Close a period and the books stop moving underneath you.",
  },
];

const WHY = [
  {
    title: "Real double-entry",
    body: "Every document posts a balanced journal entry. Nothing is a spreadsheet cell pretending to be a ledger, and the trial balance proves it.",
  },
  {
    title: "Nothing disappears quietly",
    body: "Edits reverse and repost rather than overwrite. Every change is stamped with who made it and when, and a closed period refuses new postings.",
  },
  {
    title: "Many sets of books, one login",
    body: "Run several companies side by side. Roles and sections are set per company, so a bookkeeper on one is not a bookkeeper on all of them.",
  },
  {
    title: "Built for how the work arrives",
    body: "Work orders come in on a spreadsheet, so the importer reads yours — your column names, your consultant spellings — and shows you every row before anything posts.",
  },
];

export function Landing() {
  return (
    <div className="bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      {/* ---- Navigation ---------------------------------------------- */}
      <header className="sticky top-0 z-50 border-b border-slate-200/80 bg-white/90 backdrop-blur dark:border-slate-800 dark:bg-slate-950/90">
        <nav className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3.5">
          <span className="text-lg font-bold tracking-tight">
            <span className="text-slate-900 dark:text-white">GAMI</span>
            <span className="text-brand-600 dark:text-brand-400">BOOK</span>
          </span>

          <div className="hidden items-center gap-7 md:flex">
            {NAV.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="text-sm font-medium text-slate-600 transition-colors hover:text-brand-700 dark:text-slate-300 dark:hover:text-brand-400"
              >
                {item.label}
              </a>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <Link
              href="/login"
              className="hidden rounded-lg px-3 py-2 text-sm font-medium text-slate-600 hover:text-brand-700 sm:inline-block dark:text-slate-300 dark:hover:text-brand-400"
            >
              Sign in
            </Link>
            <a
              href="#contact"
              className="rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700"
            >
              Book a demo
            </a>
          </div>
        </nav>
      </header>

      {/* ---- Hero ------------------------------------------------------ */}
      <section className="border-b border-slate-200/70 bg-slate-50/60 dark:border-slate-800 dark:bg-slate-900/30">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 lg:grid-cols-2 lg:py-24">
          <div>
            <p className="mb-4 text-xs font-semibold uppercase tracking-[0.12em] text-brand-600 dark:text-brand-400">
              Accounting for businesses that run on people
            </p>
            <h1 className="text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl">
              The books —{" "}
              <span className="text-brand-600 dark:text-brand-400">and the hours</span> behind
              them.
            </h1>
            <p className="mt-5 max-w-lg text-lg leading-relaxed text-slate-600 dark:text-slate-400">
              {APP_NAME} is proper double-entry accounting with the consultant side built in:
              a time clock, work orders, invoices and bank reconciliation, all posting to one
              set of books you can actually audit.
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href="#pricing"
                className="rounded-lg bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700"
              >
                View pricing
              </a>
              <a
                href="#contact"
                className="rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition-colors hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              >
                Book a demo
              </a>
            </div>

            <ul className="mt-8 flex flex-wrap gap-2">
              {["Double-entry ledger", "Multi-company", "Multi-currency"].map((pill) => (
                <li
                  key={pill}
                  className="rounded-full border border-slate-200 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-600 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300"
                >
                  {pill}
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-xl shadow-slate-200/50 dark:border-slate-800 dark:bg-slate-900 dark:shadow-none">
            <h2 className="mb-5 text-sm font-semibold text-slate-900 dark:text-white">
              How {APP_NAME} works for you
            </h2>
            <ol className="space-y-5">
              {HOW_IT_WORKS.map((step, index) => (
                <li key={step.title} className="flex gap-4">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-sm font-semibold text-brand-700 dark:bg-brand-950 dark:text-brand-400">
                    {index + 1}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-white">
                      {step.title}
                    </p>
                    <p className="mt-0.5 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                      {step.body}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>

        {/* The reference puts partner logos here. Ours says what the app does,
            because a logo strip under a product name claims an integration. */}
        <div className="mx-auto max-w-6xl px-4 pb-10">
          <ul className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
            {[
              "Audit trail on every change",
              "Period close",
              "Spreadsheet import",
              "CSV & PDF exports",
              "Daily backups",
            ].map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </section>

      {/* ---- Features -------------------------------------------------- */}
      <section id="features" className="scroll-mt-20 py-20">
        <div className="mx-auto max-w-6xl px-4">
          <Eyebrow>What it does</Eyebrow>
          <SectionHeading sub="One ledger underneath all of it. No exports between systems, no month-end spent reconciling two sets of numbers.">
            Everything the books need, in one place
          </SectionHeading>

          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <div
                key={feature.title}
                className="rounded-xl border border-slate-200 bg-white p-6 transition-shadow hover:shadow-md dark:border-slate-800 dark:bg-slate-900"
              >
                <FeatureIcon name={feature.icon} />
                <h3 className="mb-2 font-semibold text-slate-900 dark:text-white">
                  {feature.title}
                </h3>
                <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                  {feature.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Why (dark band, as in the reference) ---------------------- */}
      <section id="why" className="scroll-mt-20 bg-slate-900 py-20 dark:bg-slate-900/60">
        <div className="mx-auto max-w-6xl px-4">
          <p className="mb-3 text-center text-xs font-semibold uppercase tracking-[0.12em] text-brand-400">
            Why {APP_NAME}
          </p>
          <h2 className="text-center text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Built by a bookkeeper who got tired of the workarounds
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-slate-400">
            Every rule in here exists because something went wrong without it.
          </p>

          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {WHY.map((item) => (
              <div
                key={item.title}
                className="rounded-xl border border-slate-700/70 bg-slate-800/50 p-6"
              >
                <h3 className="mb-2 font-semibold text-white">{item.title}</h3>
                <p className="text-sm leading-relaxed text-slate-400">{item.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Pricing --------------------------------------------------- */}
      <section id="pricing" className="scroll-mt-20 py-20">
        <div className="mx-auto max-w-6xl px-4">
          <Eyebrow>Simple, transparent pricing</Eyebrow>
          <SectionHeading sub="Flat monthly pricing — no per-transaction fees and no charge for the consultants you track. Every plan includes the full double-entry ledger.">
            Plans that scale with your business
          </SectionHeading>

          <div className="mt-12 grid items-start gap-6 lg:grid-cols-4">
            {PLANS.map((plan) => (
              <div
                key={plan.name}
                className={`relative flex h-full flex-col rounded-xl border bg-white p-6 dark:bg-slate-900 ${
                  plan.featured
                    ? "border-brand-600 shadow-lg shadow-brand-600/10 lg:-mt-3 lg:pb-9"
                    : "border-slate-200 dark:border-slate-800"
                }`}
              >
                {plan.featured ? (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-brand-600 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                    Most popular
                  </span>
                ) : null}

                <h3 className="text-lg font-bold text-slate-900 dark:text-white">{plan.name}</h3>
                <p className="mt-2 min-h-[3.5rem] text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                  {plan.pitch}
                </p>

                <p className="mt-5">
                  <span className="text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
                    {plan.price}
                  </span>
                  {plan.period ? (
                    <span className="text-sm text-slate-500 dark:text-slate-400">
                      /{plan.period}
                    </span>
                  ) : null}
                </p>

                <ul className="mt-6 grow space-y-2.5">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex gap-2.5 text-sm">
                      <Check />
                      <span className="text-slate-600 dark:text-slate-300">{feature}</span>
                    </li>
                  ))}
                </ul>

                <a
                  href="#contact"
                  className={`mt-7 block rounded-lg px-4 py-2.5 text-center text-sm font-semibold transition-colors ${
                    plan.featured
                      ? "bg-brand-600 text-white hover:bg-brand-700"
                      : "border border-slate-300 text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:text-slate-200"
                  }`}
                >
                  {plan.cta}
                </a>
              </div>
            ))}
          </div>

          <p className="mt-8 text-center text-xs text-slate-500 dark:text-slate-400">
            Prices in Philippine pesos, billed monthly. Annual billing available on request.
          </p>
        </div>
      </section>

      {/* ---- Testimonials ---------------------------------------------
          Deliberately empty. See the note at the top of this file: a quote
          written here would be a quote from nobody. Replace `quote`, `name`
          and `role` with real ones, or delete this section outright. */}
      <section
        id="testimonials"
        className="scroll-mt-20 border-y border-slate-200 bg-slate-50/60 py-20 dark:border-slate-800 dark:bg-slate-900/30"
      >
        <div className="mx-auto max-w-3xl px-4">
          <SectionHeading sub="Real words from the businesses whose books run on it.">
            Trusted by business owners
          </SectionHeading>

          <div className="mt-10 rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center dark:border-slate-700 dark:bg-slate-900">
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
              Client quotes go here.
            </p>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-500 dark:text-slate-400">
              Ask two or three clients for a sentence about what changed after they moved to{" "}
              {APP_NAME}, and they replace this box. Until then it stays blank on purpose —
              an invented testimonial is worth less than none.
            </p>
          </div>
        </div>
      </section>

      {/* ---- Contact --------------------------------------------------- */}
      <section id="contact" className="scroll-mt-20 py-20">
        <div className="mx-auto grid max-w-6xl gap-12 px-4 lg:grid-cols-2">
          <div>
            <Eyebrow>
              <span className="block text-left">Get in touch</span>
            </Eyebrow>
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              See it on your own books
            </h2>
            <p className="mt-4 max-w-md leading-relaxed text-slate-600 dark:text-slate-400">
              A short walkthrough with your own chart of accounts and a month of real
              documents, so you can judge it on your work rather than a demo company.
            </p>

            <dl className="mt-8 space-y-5">
              {[
                { term: "Email", detail: CONTACT_EMAIL },
                { term: "Response time", detail: "Within 1 business day" },
                { term: "Serving", detail: "Philippines and remote, worldwide" },
              ].map((row) => (
                <div key={row.term}>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                    {row.term}
                  </dt>
                  <dd className="mt-0.5 font-medium text-slate-900 dark:text-white">
                    {row.detail}
                  </dd>
                </div>
              ))}
            </dl>
          </div>

          <ContactForm />
        </div>
      </section>

      {/* ---- Footer ---------------------------------------------------- */}
      <footer className="bg-slate-900 py-14 text-slate-400">
        <div className="mx-auto grid max-w-6xl gap-10 px-4 sm:grid-cols-3">
          <div>
            <span className="text-lg font-bold tracking-tight">
              <span className="text-white">GAMI</span>
              <span className="text-brand-400">BOOK</span>
            </span>
            <p className="mt-3 max-w-xs text-sm leading-relaxed">
              Double-entry accounting with consultant time tracking built in, for businesses
              that bill for people&rsquo;s hours.
            </p>
          </div>

          <div>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-white">
              Product
            </h3>
            <ul className="space-y-2 text-sm">
              {NAV.map((item) => (
                <li key={item.href}>
                  <a href={item.href} className="hover:text-white">
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-white">
              Get in touch
            </h3>
            <ul className="space-y-2 text-sm">
              <li>
                <a href="#contact" className="hover:text-white">
                  Book a demo
                </a>
              </li>
              <li>
                <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-white">
                  {CONTACT_EMAIL}
                </a>
              </li>
              <li>
                <Link href="/login" className="hover:text-white">
                  Sign in
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="mx-auto mt-10 max-w-6xl border-t border-slate-800 px-4 pt-6 text-xs">
          &copy; {new Date().getFullYear()} {APP_NAME}. All rights reserved.
        </div>
      </footer>
    </div>
  );
}
