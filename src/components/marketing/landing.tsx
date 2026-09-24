import Link from "next/link";
import {
  CONTACT_DETAILS,
  CONTACT_EMAIL,
  CREDENTIALS,
  HERO,
  HOW_WE_WORK,
  PLANS,
  PLATFORM_ADDON,
  PLATFORM_OPTIONS,
  SERVICES,
  TESTIMONIALS,
  WHY,
  type Recommendation,
  type UpworkReview,
} from "./content";
import { ContactForm } from "./contact-form";

/**
 * The public landing page (gamibook.com, signed out).
 *
 * Structure and copy follow the BookkeepingPoint site the owner supplied: the
 * service, the four tiers and the recommendations are hers, and the same
 * practice stands behind both. One section exists here that does not exist
 * there — "Your books, on your system or ours" — because that is the whole
 * difference: GAMIBOOK runs on an accounting platform clients can have for a
 * flat monthly fee, and clients who would rather stay in QuickBooks can.
 *
 * The credential strip (QuickBooks ProAdvisor, Xero Certified, …) belongs on
 * this page in a way it would not on a software product's: these certify the
 * bookkeeper doing the work, and the work is what is being sold.
 *
 * All copy lives in ./content. Nothing here needs editing to change a price.
 */

function Eyebrow({ children, align = "center" }: { children: React.ReactNode; align?: "center" | "left" }) {
  return (
    <p
      className={`mb-3 text-xs font-semibold uppercase tracking-[0.14em] text-brand-600 dark:text-brand-400 ${
        align === "center" ? "text-center" : "text-left"
      }`}
    >
      {children}
    </p>
  );
}

function SectionHeading({ children, sub }: { children: React.ReactNode; sub?: string }) {
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

function Stars({ label }: { label?: string }) {
  return (
    <p className="flex items-center gap-1.5">
      <span className="text-sm tracking-wide text-amber-400" aria-label="5 out of 5">
        {"★★★★★"}
      </span>
      {label ? (
        <span className="text-xs font-semibold text-slate-600 dark:text-slate-300">{label}</span>
      ) : null}
    </p>
  );
}

const SERVICE_ICONS = {
  book: <path d="M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2V5Zm4 3h7M8 12h7" />,
  bank: <path d="M3 9 12 4l9 5M5 10v7m5-7v7m5-7v7m5-7v7M3 20h18" />,
  chart: <path d="M4 20V10m5 10V4m5 16v-7m5 7V8" />,
  cash: <path d="M2 7h20v10H2zM12 12a2 2 0 1 0 0 .01M6 12h.01M18 12h.01" />,
  payroll: <path d="M16 20v-1a4 4 0 0 0-8 0v1M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7 9v-1a3 3 0 0 0-2-2.8" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />,
};

function ServiceIcon({ name }: { name: keyof typeof SERVICE_ICONS }) {
  return (
    <span className="mb-4 inline-flex size-11 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-950 dark:text-brand-400">
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
        {SERVICE_ICONS[name]}
      </svg>
    </span>
  );
}

const NAV = [
  { href: "#services", label: "Services" },
  { href: "#why", label: "Why Us" },
  { href: "#system", label: "Your System" },
  { href: "#pricing", label: "Pricing" },
  { href: "#testimonials", label: "Testimonials" },
  { href: "#contact", label: "Contact" },
];

/** One LinkedIn recommendation, rendered as LinkedIn shows it. */
function RecommendationCard({ item }: { item: Recommendation }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8 dark:border-slate-800 dark:bg-slate-900">
      <header className="flex gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-brand-600 text-sm font-bold text-white">
          {item.initials}
        </span>
        <div>
          <p className="font-bold text-slate-900 dark:text-white">{item.name}</p>
          <p className="text-sm text-slate-600 dark:text-slate-400">{item.role}</p>
          <p className="mt-0.5 text-xs text-slate-400 dark:text-slate-500">{item.meta}</p>
        </div>
      </header>

      {item.lead ? (
        <p className="mt-4 text-sm italic leading-relaxed text-slate-600 dark:text-slate-400">
          {item.lead}
        </p>
      ) : null}

      <div className="mt-4 space-y-3">
        {item.paragraphs.map((paragraph) => (
          <p key={paragraph.slice(0, 40)} className="text-sm leading-relaxed text-slate-700 dark:text-slate-300">
            {paragraph}
          </p>
        ))}
      </div>

      <div className="mt-5">
        <Stars />
      </div>
    </article>
  );
}

/** One Upwork review — a job title, a rating and the client's words. */
function UpworkCard({ item }: { item: UpworkReview }) {
  return (
    <article className="rounded-xl border border-slate-200 bg-white p-6 sm:p-8 dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs font-bold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
        Upwork review
      </p>
      <h3 className="mt-2 font-bold text-slate-900 dark:text-white">{item.project}</h3>
      <div className="mt-2">
        <Stars label={item.rating} />
      </div>
      <p className="mt-4 text-sm italic leading-relaxed text-slate-700 dark:text-slate-300">
        &ldquo;{item.quote}&rdquo;
      </p>
      <p className="mt-5 flex flex-wrap items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        {item.status}
        {item.badge ? (
          <span className="rounded bg-slate-100 px-2 py-1 font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
            {item.badge}
          </span>
        ) : null}
      </p>
    </article>
  );
}

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

          <div className="hidden items-center gap-6 lg:flex">
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
              className="whitespace-nowrap rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700"
            >
              Get a Free Consultation
            </a>
          </div>
        </nav>
      </header>

      {/* ---- Hero ------------------------------------------------------ */}
      <section className="bg-slate-50/60 dark:bg-slate-900/30">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 py-16 lg:grid-cols-2 lg:py-24">
          <div>
            <Eyebrow align="left">{HERO.eyebrow}</Eyebrow>
            <h1 className="text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl">
              {HERO.headlineBefore}{" "}
              <span className="text-brand-600 dark:text-brand-400">{HERO.headlineAccent}</span>{" "}
              {HERO.headlineAfter}
            </h1>
            <p className="mt-5 max-w-lg leading-relaxed text-slate-600 dark:text-slate-400">
              {HERO.body}
            </p>

            <div className="mt-8 flex flex-wrap gap-3">
              <a
                href="#pricing"
                className="rounded-lg bg-brand-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700"
              >
                View Pricing
              </a>
              <a
                href="#contact"
                className="rounded-lg border border-slate-300 bg-white px-5 py-3 text-sm font-semibold text-slate-700 transition-colors hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200"
              >
                Book a Free Call
              </a>
            </div>

            <ul className="mt-8 flex flex-wrap gap-2">
              {HERO.pills.map((pill) => (
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
              How we work for you
            </h2>
            <ul className="space-y-5">
              {HOW_WE_WORK.map((step, index) => (
                <li key={step.title} className="flex gap-4">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-sm font-semibold text-brand-700 dark:bg-brand-950 dark:text-brand-400">
                    {index + 1}
                  </span>
                  <div>
                    <p className="text-sm font-semibold text-slate-900 dark:text-white">
                      {step.title}
                    </p>
                    <p className="mt-0.5 text-sm text-slate-600 dark:text-slate-400">{step.body}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="mx-auto max-w-6xl px-4 pb-12">
          <ul className="flex flex-wrap items-center justify-center gap-x-8 gap-y-3 text-sm font-medium text-slate-400 dark:text-slate-500">
            {CREDENTIALS.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      </section>

      {/* ---- Services -------------------------------------------------- */}
      <section id="services" className="scroll-mt-20 py-20">
        <div className="mx-auto max-w-6xl px-4">
          <Eyebrow>What we do</Eyebrow>
          <SectionHeading sub="Everything you need to keep your finances organized, compliant, and decision-ready.">
            Full-service bookkeeping, done right
          </SectionHeading>

          <div className="mt-12 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {SERVICES.map((service) => (
              <div
                key={service.title}
                className="rounded-xl border border-slate-200 bg-white p-6 transition-shadow hover:shadow-md dark:border-slate-800 dark:bg-slate-900"
              >
                <ServiceIcon name={service.icon} />
                <h3 className="mb-2 font-bold text-slate-900 dark:text-white">{service.title}</h3>
                <p className="text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                  {service.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Why us (dark band) ---------------------------------------- */}
      <section id="why" className="scroll-mt-20 bg-slate-900 py-20">
        <div className="mx-auto max-w-6xl px-4">
          <p className="mb-3 text-center text-xs font-semibold uppercase tracking-[0.14em] text-brand-400">
            Why GAMIBOOK
          </p>
          <h2 className="text-center text-3xl font-bold tracking-tight text-white sm:text-4xl">
            {WHY.heading}
          </h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-slate-400">{WHY.sub}</p>

          <div className="mt-12 grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {WHY.cards.map((card) => (
              <div
                key={card.title}
                className="rounded-xl border border-slate-700/70 bg-slate-800/50 p-6"
              >
                <h3 className="mb-2 font-bold text-white">{card.title}</h3>
                <p className="text-sm leading-relaxed text-slate-400">{card.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- The system choice ----------------------------------------
          The one section BookkeepingPoint does not have, and the reason this
          site exists separately. */}
      <section id="system" className="scroll-mt-20 py-20">
        <div className="mx-auto max-w-5xl px-4">
          <Eyebrow>The GAMIBOOK difference</Eyebrow>
          <SectionHeading sub="Every plan below includes the bookkeeping. The only question is which software your books live in — and both answers are fine by us.">
            Your books, on your system or ours
          </SectionHeading>

          <div className="mt-12 grid gap-6 md:grid-cols-2">
            {PLATFORM_OPTIONS.map((option) => (
              <div
                key={option.name}
                className={`flex flex-col rounded-xl border bg-white p-7 dark:bg-slate-900 ${
                  option.featured
                    ? "border-brand-600 shadow-lg shadow-brand-600/10"
                    : "border-slate-200 dark:border-slate-800"
                }`}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-lg font-bold text-slate-900 dark:text-white">
                    {option.name}
                  </h3>
                  <p className="whitespace-nowrap">
                    <span className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">
                      {option.price}
                    </span>
                    {option.period ? (
                      <span className="text-sm text-slate-500 dark:text-slate-400">
                        /{option.period}
                      </span>
                    ) : null}
                  </p>
                </div>

                <p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                  {option.pitch}
                </p>

                <ul className="mt-6 grow space-y-2.5">
                  {option.features.map((feature) => (
                    <li key={feature} className="flex gap-2.5 text-sm">
                      <Check />
                      <span className="text-slate-600 dark:text-slate-300">{feature}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ---- Pricing --------------------------------------------------- */}
      <section
        id="pricing"
        className="scroll-mt-20 border-y border-slate-200 bg-slate-50/60 py-20 dark:border-slate-800 dark:bg-slate-900/30"
      >
        <div className="mx-auto max-w-6xl px-4">
          <Eyebrow>Simple, transparent pricing</Eyebrow>
          <SectionHeading sub="Flat weekly pricing — no hourly surprises. Choose the level of support that fits where you are.">
            Plans that scale with your business
          </SectionHeading>

          <div className="mt-12 grid items-start gap-6 lg:grid-cols-4">
            {PLANS.map((plan) => (
              <div
                key={plan.name}
                className={`relative flex h-full flex-col rounded-xl border bg-white p-6 dark:bg-slate-900 ${
                  plan.featured
                    ? "border-brand-600 shadow-lg shadow-brand-600/10 lg:-mt-3"
                    : "border-slate-200 dark:border-slate-800"
                }`}
              >
                {plan.featured ? (
                  <span className="absolute -top-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-brand-600 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-white">
                    Most popular
                  </span>
                ) : null}

                <h3 className="text-lg font-bold text-slate-900 dark:text-white">{plan.name}</h3>
                <p className="mt-2 min-h-[4rem] text-sm leading-relaxed text-slate-600 dark:text-slate-400">
                  {plan.pitch}
                </p>

                <p className="mt-4">
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

                <p className="mt-6 border-t border-dashed border-slate-200 pt-4 text-xs leading-relaxed text-slate-500 dark:border-slate-700 dark:text-slate-400">
                  {PLATFORM_ADDON}
                </p>

                <a
                  href="#contact"
                  className={`mt-5 block rounded-lg px-4 py-2.5 text-center text-sm font-semibold transition-colors ${
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
        </div>
      </section>

      {/* ---- Testimonials ---------------------------------------------- */}
      <section id="testimonials" className="scroll-mt-20 py-20">
        <div className="mx-auto max-w-3xl px-4">
          <SectionHeading sub="Real recommendations from people whose books we've kept.">
            Trusted by business owners
          </SectionHeading>

          <div className="mt-10 space-y-6">
            {TESTIMONIALS.map((item) =>
              item.kind === "linkedin" ? (
                <RecommendationCard key={item.name} item={item} />
              ) : (
                <UpworkCard key={item.project} item={item} />
              ),
            )}
          </div>
        </div>
      </section>

      {/* ---- Closing call to action ------------------------------------ */}
      <section className="bg-brand-600 py-16 text-center">
        <div className="mx-auto max-w-2xl px-4">
          <h2 className="text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Ready to stop worrying about your books?
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-brand-100">
            Book a free, no-pressure consultation. We&rsquo;ll review where things stand and show
            you exactly how we can help.
          </p>
          <a
            href="#contact"
            className="mt-8 inline-block rounded-lg bg-white px-6 py-3 text-sm font-semibold text-brand-700 shadow-sm transition-colors hover:bg-brand-50"
          >
            Get a Free Consultation
          </a>
        </div>
      </section>

      {/* ---- Contact --------------------------------------------------- */}
      <section id="contact" className="scroll-mt-20 py-20">
        <div className="mx-auto grid max-w-6xl gap-12 px-4 lg:grid-cols-2">
          <div>
            <Eyebrow align="left">Get in touch</Eyebrow>
            <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">
              Let&rsquo;s talk about your business
            </h2>
            <p className="mt-4 max-w-md leading-relaxed text-slate-600 dark:text-slate-400">
              Tell us a little about your needs and we&rsquo;ll get back to you within one business
              day to set up your free consultation.
            </p>

            <dl className="mt-8 space-y-5">
              {CONTACT_DETAILS.map((row) => (
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
              Accurate, reliable bookkeeping for small businesses and entrepreneurs. Your books,
              handled — so you can focus on growth.
            </p>
          </div>

          <div>
            <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-white">
              Company
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
                  Free Consultation
                </a>
              </li>
              <li>
                <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-white">
                  {CONTACT_EMAIL}
                </a>
              </li>
              <li>
                <Link href="/login" className="hover:text-white">
                  Client sign in
                </Link>
              </li>
            </ul>
          </div>
        </div>

        <div className="mx-auto mt-10 max-w-6xl border-t border-slate-800 px-4 pt-6 text-xs">
          &copy; {new Date().getFullYear()} GAMIBOOK. All rights reserved.
        </div>
      </footer>
    </div>
  );
}
