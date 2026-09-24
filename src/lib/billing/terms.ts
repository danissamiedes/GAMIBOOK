/**
 * The terms people agree to at signup (SPEC §16).
 *
 * Kept as data rather than markup so the same words can be shown on the terms
 * page, quoted in an email, and — the point of the version string — compared
 * against what a given user actually accepted.
 *
 * **These are a working draft, not legal advice.** They were written to be
 * accurate about what this software does and honest about what it does not
 * promise, which is the part a lawyer cannot supply. What a lawyer must supply
 * is the rest: whether they are enforceable where the business is registered,
 * what consumer law overrides, and what a data protection regime requires.
 * Have them reviewed before taking money from a stranger.
 */

/**
 * Bump this whenever the wording changes in a way that alters what someone
 * agreed to. A date is used rather than a number so a stored consent says when
 * it was given without a lookup table.
 */
export const TERMS_VERSION = "2026-09-24";

export const TERMS_EFFECTIVE = "24 September 2026";

export type TermsSection = { heading: string; paragraphs: string[] };

export const TERMS: TermsSection[] = [
  {
    heading: "Who these terms are between",
    paragraphs: [
      "These terms are between you — the person or business opening the account — and GAMIBOOK, operated by Danissa Miedes. They cover the GAMIBOOK accounting software. They do not cover the bookkeeping service, which is a separate professional engagement with its own written scope and fee.",
      "By ticking the box at signup you confirm you have read these terms, that you accept them, and that you have authority to accept them on behalf of the business you are registering.",
    ],
  },
  {
    heading: "The subscription and what it costs",
    paragraphs: [
      "The GAMIBOOK system is $20 per month per organization, billed in advance through PayPal, and renews automatically each month until it is cancelled. The price shown at checkout is the price you pay; we will give you at least 30 days' notice by email before any change takes effect, and you may cancel before it does.",
      "PayPal, not this website, handles your payment details. We never see or store your card number.",
    ],
  },
  {
    heading: "Cancelling, and what happens to your books",
    paragraphs: [
      "You can cancel at any time from your PayPal account. Cancellation takes effect at the end of the period you have already paid for, and we do not refund part-months.",
      "If a payment fails, your account keeps working in full for 14 days so an expired card is an inconvenience rather than an emergency. After that the books become read-only: you can still sign in, read everything, run every report and export your data, but no new transactions can be posted until the subscription is settled.",
      "We will not delete your accounting records because you stopped paying. If you want them removed, ask us and we will delete them.",
    ],
  },
  {
    heading: "Your data is yours",
    paragraphs: [
      "You own everything you put into GAMIBOOK. We store and process it to run the service for you, and for no other purpose: we do not sell it, we do not share it with advertisers, and we do not use it to train anything.",
      "You can export your data at any time, in CSV and PDF, without asking us. That is deliberate — software you cannot leave is software you cannot trust.",
      "We may access your data when you ask us to help with a problem, or where we are legally required to. Staff access is logged.",
    ],
  },
  {
    heading: "Keeping it safe, and keeping your own copy",
    paragraphs: [
      "We take reasonable measures to protect your data: encrypted connections, hashed passwords, access limited by role, and regular backups. No system is perfect and we do not claim otherwise.",
      "Please keep your own backups of anything you cannot afford to lose. Exporting regularly costs you a minute and removes a single point of failure.",
      "You are responsible for your account's passwords and for who you invite into your books. Tell us promptly if you think someone has access who should not.",
    ],
  },
  {
    heading: "What this software is, and is not",
    paragraphs: [
      "GAMIBOOK is a bookkeeping tool. It is not accounting advice, tax advice, or legal advice, and it does not file anything with any tax authority on your behalf.",
      "You remain responsible for the accuracy of your records and for your own tax and reporting obligations. The figures it produces are only as good as what is entered, and you should have a qualified accountant review them before you rely on them for a filing.",
    ],
  },
  {
    heading: "Availability",
    paragraphs: [
      "We work to keep the service running and available, but we do not guarantee it will never be interrupted. Maintenance, hosting failures and problems at third parties we depend on can all take it offline.",
      "Where we know about planned downtime in advance, we will tell you in advance.",
    ],
  },
  {
    heading: "Acceptable use",
    paragraphs: [
      "Use GAMIBOOK for lawful business purposes. Do not attempt to break into it, disrupt it for other users, reverse-engineer it, resell access to it, or use it to store anything unlawful.",
      "We may suspend an account that is being used this way, and we will tell you why.",
    ],
  },
  {
    heading: "Limits on our liability",
    paragraphs: [
      "To the extent the law allows, our total liability to you for any claim relating to the software is limited to the subscription fees you paid us in the twelve months before the claim arose.",
      "We are not liable for lost profits, lost business, or losses arising from decisions made on figures in the system. Nothing here limits liability that cannot lawfully be limited.",
    ],
  },
  {
    heading: "Ending the agreement",
    paragraphs: [
      "You may stop using GAMIBOOK at any time. We may end your subscription with 30 days' written notice, or immediately if these terms are seriously breached.",
      "If we end it, we will give you a reasonable opportunity to export your data first.",
    ],
  },
  {
    heading: "Changes to these terms",
    paragraphs: [
      "We may update these terms. If a change materially affects your rights we will email you at least 30 days before it takes effect, and continuing to use the service after that date means you accept the new version.",
      "Every version carries a date, and the version you accepted is recorded against your account.",
    ],
  },
  {
    heading: "Questions",
    paragraphs: [
      "Anything at all about these terms, your data, or your subscription: email dm@bookkeepingpoint.com and a person will answer.",
    ],
  },
];
