/**
 * What the landing page charges, and who to write to.
 *
 * Separate from the page so the numbers can be changed without reading JSX —
 * this file is the one to edit when pricing moves.
 *
 * THE FIGURES BELOW ARE PLACEHOLDERS. They are shaped the way the reference
 * site's tiers are shaped (three priced, one "let's talk", the middle one
 * flagged), and sized against what the app actually meters — companies, user
 * seats, consultants — but nobody has agreed them. Set them before the page
 * goes public.
 *
 * One deliberate difference from the reference: it prices a bookkeeping
 * *service* by the week, because a person does the work. This is software, so
 * it prices by the month.
 */

export const CONTACT_EMAIL = "dm@bookkeepingpoint.com";

export type Plan = {
  name: string;
  /** Who this tier is for. One sentence, shown under the name. */
  pitch: string;
  /** Rendered large. "Let's talk" is a legitimate value here. */
  price: string;
  /** Appended after a slash. Omit for the custom tier. */
  period?: string;
  /** The middle tier, drawn with the "Most popular" badge. */
  featured?: boolean;
  cta: string;
  features: string[];
};

export const PLANS: Plan[] = [
  {
    name: "Starter",
    pitch: "For a single business keeping its own books in order.",
    price: "₱1,500",
    period: "month",
    cta: "Start with Starter",
    features: [
      "1 company",
      "2 user logins",
      "Up to 5 consultants tracked",
      "Invoices, bills and expenses",
      "Bank import and reconciliation",
      "P&L, balance sheet, trial balance",
      "Email support",
    ],
  },
  {
    name: "Growth",
    pitch: "For a growing services business billing for people's time.",
    price: "₱3,500",
    period: "month",
    featured: true,
    cta: "Choose Growth",
    features: [
      "Everything in Starter, plus:",
      "3 companies",
      "10 user logins",
      "Up to 25 consultants tracked",
      "Consultant time clock",
      "Work order import and bulk send",
      "Bulk pay across work orders",
      "Recurring invoices and bills",
    ],
  },
  {
    name: "Business",
    pitch: "For a practice keeping books for several clients at once.",
    price: "₱7,500",
    period: "month",
    cta: "Choose Business",
    features: [
      "Everything in Growth, plus:",
      "10 companies",
      "Unlimited user logins",
      "Unlimited consultants",
      "Per-company roles and sections",
      "Multi-currency with FX gain/loss",
      "Period close and audit trail",
      "Priority support",
    ],
  },
  {
    name: "Custom",
    pitch: "More companies, higher volume, or something specific to your practice.",
    price: "Let's talk",
    cta: "Get in touch",
    features: [
      "Unlimited companies",
      "Migration from your current system",
      "Custom chart of accounts setup",
      "Consolidated reporting",
      "Dedicated onboarding",
      "Tailored terms",
    ],
  },
];

/** The tier names, for the contact form's dropdown. */
export const PLAN_OPTIONS = PLANS.map((plan) =>
  plan.period ? `${plan.name} — ${plan.price}/${plan.period}` : `${plan.name} — ${plan.price}`,
);
