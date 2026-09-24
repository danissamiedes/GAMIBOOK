/**
 * Everything the landing page says, separated from how it looks.
 *
 * Copy, prices and testimonials change far more often than layout does, and
 * hunting for a price inside JSX is how a wrong number survives three edits.
 * This file is the one to open to change what the page claims.
 *
 * The service, the tiers and the testimonials are BookkeepingPoint's, supplied
 * by the owner. GAMIBOOK is the same practice with one thing added: the
 * accounting system it runs on is available to clients, and some will want it
 * while others would rather stay in QuickBooks. That choice is the only
 * structural difference between the two sites, and it lives in
 * `PLATFORM_OPTIONS` and in `PLATFORM_ADDON`.
 */

export const CONTACT_EMAIL = "dm@bookkeepingpoint.com";
export const OWNER_NAME = "Danissa Miedes";

/* -------------------------------------------------------------------------
 * Hero
 * ---------------------------------------------------------------------- */

export const HERO = {
  eyebrow: "Bookkeeping for growing businesses",
  /** Split so the middle phrase can be set in the accent colour. */
  headlineBefore: "Your books,",
  headlineAccent: "handled",
  headlineAfter: "— so you can focus on the business.",
  body: "GAMIBOOK delivers accurate, on-time bookkeeping for small businesses and entrepreneurs. Clean records, clear reports, and a partner who actually understands how you work — on our own accounting system, or on the one you already use.",
  pills: ["Technology-driven", "15+ years experience", "Your virtual bookkeeper"],
};

export const HOW_WE_WORK = [
  { title: "Streamline", body: "Organized, consistent financial workflows" },
  { title: "Automate", body: "Smart tools that cut manual work and errors" },
  { title: "Simplify", body: "Clear numbers you can actually act on" },
  { title: "Low cost, high value", body: "Efficient service that saves you time and money" },
];

/** Practitioner credentials. These certify the bookkeeper, not the software. */
export const CREDENTIALS = [
  "QuickBooks ProAdvisor",
  "Xero Certified",
  "FreshBooks",
  "Wave",
  "Gusto Payroll",
  "Bill.com",
];

/* -------------------------------------------------------------------------
 * Services
 * ---------------------------------------------------------------------- */

export const SERVICES = [
  {
    icon: "book" as const,
    title: "Monthly Bookkeeping",
    body: "Day-to-day recording of income and expenses, categorized accurately and kept current month after month.",
  },
  {
    icon: "bank" as const,
    title: "Bank & Credit Reconciliation",
    body: "Every account matched to the penny so your numbers always tie out and nothing slips through the cracks.",
  },
  {
    icon: "chart" as const,
    title: "Financial Reporting",
    body: "Clear P&L, balance sheet, and cash flow statements delivered monthly so you always know where you stand.",
  },
  {
    icon: "cash" as const,
    title: "Accounts Payable & Receivable",
    body: "Bills paid on time, invoices sent and tracked, and a healthy cash flow you can count on.",
  },
  {
    icon: "payroll" as const,
    title: "Payroll Support",
    body: "Accurate payroll processing, filings, and records that keep your team paid and your business compliant.",
  },
  {
    icon: "folder" as const,
    title: "Tax-Ready Books",
    body: "Clean, organized records handed off to your CPA at year-end — no scramble, no surprises.",
  },
];

/* -------------------------------------------------------------------------
 * Why us
 * ---------------------------------------------------------------------- */

export const WHY = {
  heading: "A bookkeeper who learns your business",
  sub: "Freelancers helped, but never took the time to understand. We do things differently.",
  cards: [
    {
      title: "Built on trust",
      body: "The most important part of handing over your books. We treat your business like our own.",
    },
    {
      title: "Goal-aligned",
      body: "We listen to your goals and shape your reporting around the numbers that actually matter to you.",
    },
    {
      title: "Always responsive",
      body: "Quick replies, clear communication, and a real person who knows your account.",
    },
    {
      title: "Thorough & accurate",
      body: "Detail-obsessed work on every task, including the obscure projects others won't touch.",
    },
  ],
};

/* -------------------------------------------------------------------------
 * The system choice — what GAMIBOOK has that the service alone does not
 * ---------------------------------------------------------------------- */

export const PLATFORM_ADDON_PRICE = "$20";
export const PLATFORM_ADDON_PERIOD = "month";

/** One line, reused inside every pricing card. */
export const PLATFORM_ADDON = `Add the GAMIBOOK system for ${PLATFORM_ADDON_PRICE}/${PLATFORM_ADDON_PERIOD}, or we work in your own`;

export const PLATFORM_OPTIONS = [
  {
    name: "The GAMIBOOK system",
    price: `+${PLATFORM_ADDON_PRICE}`,
    period: PLATFORM_ADDON_PERIOD,
    featured: true,
    pitch:
      "Our own accounting platform, included with your plan for a flat monthly fee. You get your own login and can see the books as they are kept, not a month after.",
    features: [
      "Your own login, on any device",
      "Invoices, bills and expenses in one ledger",
      "Consultant work orders and a time clock",
      "Bank import and reconciliation",
      "Profit & loss by month, with gross margin",
      "Multi-currency, and several companies if you run them",
      "Every change stamped with who made it",
    ],
  },
  {
    name: "Your own system",
    price: "Included",
    pitch:
      "Already on QuickBooks and happy there? We work inside your file. Nothing migrates, nothing changes, and your accountant keeps the access they already have.",
    features: [
      "We work in your QuickBooks file",
      "Xero, FreshBooks and Wave also supported",
      "No migration and no data conversion",
      "Keep your existing subscription",
      "Your CPA keeps their access",
      "Same reports, same deadlines",
      "Switch to the GAMIBOOK system later if you want",
    ],
  },
];

/* -------------------------------------------------------------------------
 * Pricing
 * ---------------------------------------------------------------------- */

export type Plan = {
  name: string;
  pitch: string;
  price: string;
  period?: string;
  featured?: boolean;
  cta: string;
  features: string[];
};

export const PLANS: Plan[] = [
  {
    name: "Essential",
    pitch: "For solo owners and early-stage businesses that need clean, current books.",
    price: "$350",
    period: "week",
    cta: "Get Started",
    features: [
      "Monthly bookkeeping & categorization",
      "Up to 2 bank/credit accounts reconciled",
      "Up to 100 transactions / month",
      "Monthly Profit & Loss statement",
      "Email support (48-hr response)",
      "Year-end tax-ready file",
    ],
  },
  {
    name: "Growth",
    pitch: "For growing businesses that need fuller reporting and faster turnaround.",
    price: "$500",
    period: "week",
    featured: true,
    cta: "Get Started",
    features: [
      "Everything in Essential, plus:",
      "Up to 5 accounts reconciled",
      "Up to 300 transactions / month",
      "P&L, balance sheet & cash flow",
      "Accounts payable & receivable",
      "Monthly review call",
      "Priority support (24-hr response)",
    ],
  },
  {
    name: "Premium",
    pitch: "For established businesses needing hands-on, comprehensive financial management.",
    price: "$750",
    period: "week",
    cta: "Get Started",
    features: [
      "Everything in Growth, plus:",
      "Unlimited accounts reconciled",
      "Up to 750 transactions / month",
      "Payroll processing & support",
      "Custom KPI & management reporting",
      "Class / department tracking",
      "Dedicated bookkeeper + same-day support",
    ],
  },
  {
    name: "Custom",
    pitch: "Multi-entity, high-volume, or specialized needs? Let's build a plan around you.",
    price: "Let's talk",
    cta: "Contact Us",
    features: [
      "Multi-entity & consolidated books",
      "High transaction volume",
      "Industry-specific reporting (AIB, SQF, audit-ready)",
      "Catch-up & clean-up projects",
      "CFO-level advisory add-ons",
      "Tailored scope & pricing",
    ],
  },
];

/** Tier names for the contact form's dropdown. */
export const PLAN_OPTIONS = PLANS.map((plan) =>
  plan.period ? `${plan.name} — ${plan.price}/${plan.period}` : `${plan.name} — ${plan.price}`,
);

/* -------------------------------------------------------------------------
 * Testimonials
 *
 * Real recommendations about the owner, supplied by her. Two are LinkedIn
 * recommendations, three are Upwork reviews. Quoted as written — editing a
 * recommendation for flow is editing what somebody said.
 * ---------------------------------------------------------------------- */

export type Recommendation = {
  kind: "linkedin";
  initials: string;
  name: string;
  role: string;
  meta: string;
  /** The short summary line LinkedIn shows above the body, if there was one. */
  lead?: string;
  paragraphs: string[];
};

export type UpworkReview = {
  kind: "upwork";
  project: string;
  rating: string;
  quote: string;
  /** "Endorsed by client", "Job in progress" — whatever Upwork showed. */
  status: string;
  badge?: string;
};

export const TESTIMONIALS: (Recommendation | UpworkReview)[] = [
  {
    kind: "linkedin",
    initials: "DB",
    name: "David Bennett",
    role: "Commercial Account Manager",
    meta: "April 16, 2020 · David was Danissa's client",
    lead: "Collaborative innovation, flexibility, creative expansive options for a sustainable plan. Comprehensive reporting, compliance with audit requirements (AIB, SQF, BRC, FDA, GMP).",
    paragraphs: [
      "A critical aspect of any business is allocation of time and resources aligned to goals. As a small business owner, I was spending an extraordinary amount of time on the bookkeeping. I worked with a couple of freelancers in this area who, although they helped, did not take time to understand my specific business.",
      "By chance I connected with Danissa Miedes on LinkedIn, expanded the dialogue, and secured the opportunity to have her manage the bookkeeping — and the most important component was trust. Danissa listened to my goals, was instrumental in formulating the data I was looking for, took on obscure projects when they arose, and was always responsive with excellent communication skills and more virtues too numerous to mention. The result was a crucial component of my business that I inherently did not need to worry about.",
      "Highly recommend her services for any business — she will prove to be significantly valuable.",
    ],
  },
  {
    kind: "linkedin",
    initials: "KT",
    name: "Kal Takhar",
    role: "Real Estate Developer / Builder",
    meta: "December 27, 2010 · Kal was Danissa's client",
    paragraphs: [
      "Danissa provided excellent results and was very thorough on whatever task she was assigned. I highly recommend her and would definitely rehire her.",
    ],
  },
  {
    kind: "upwork",
    project: "Monthly Online Accounting / Financial Statements and Year End",
    rating: "5.0",
    quote:
      "Danissa is a 5 star contractor all the way around. She is fast and efficient, making quick work of a large task. Her communication methods are excellent — clear and concise, explaining exactly what is needed without a lot of back and forth time wasting. Highly recommend!",
    status: "Endorsed by client",
    badge: "Clear Communicator",
  },
  {
    kind: "upwork",
    project: "QuickBooks Data Entry",
    rating: "5.0",
    quote:
      "She did a fantastic job for us for several years! I would highly recommend her for work on QuickBooks. Recommended!",
    status: "Endorsed by client",
    badge: "Committed to Quality",
  },
  {
    kind: "upwork",
    project: "Fine Edge Bookkeeping",
    rating: "5.0",
    quote:
      "Danissa Miedes continues to prove she is a very hard worker managing my books month to month. Now my accountant gets the books on time, no problem.",
    status: "Job in progress",
  },
];

/* -------------------------------------------------------------------------
 * Contact
 * ---------------------------------------------------------------------- */

export const CONTACT_DETAILS = [
  { term: "Email", detail: CONTACT_EMAIL },
  { term: "Response time", detail: "Within 1 business day" },
  { term: "Serving", detail: "Remote bookkeeping, nationwide" },
];
