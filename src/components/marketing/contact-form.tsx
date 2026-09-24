"use client";

import { useState } from "react";
import { CONTACT_EMAIL, PLAN_OPTIONS, PLATFORM_ADDON_PRICE } from "./content";

/**
 * The consultation enquiry form.
 *
 * It opens the visitor's mail client with the message composed, rather than
 * posting anywhere. That is a deliberate first step, not an oversight: a form
 * that POSTs needs somewhere for leads to land — a table, an inbox, a webhook —
 * and picking that before anyone has asked for a consultation is building a
 * feature nobody has needed yet. A mailto works on day one, with nothing to
 * maintain and nothing to leak.
 *
 * The cost is real and worth stating: it needs a mail client configured, and
 * an enquiry only exists once the visitor presses send in it. When enquiries
 * start arriving, replace the body of `compose` with a server action.
 */
export function ContactForm() {
  const [sent, setSent] = useState(false);

  function compose(formData: FormData) {
    const read = (key: string) => String(formData.get(key) || "").trim();
    const name = read("name");
    const business = read("business");

    const subject = `Free consultation request${business ? ` — ${business}` : ""}`;
    const body = [
      `Name: ${name || "(not given)"}`,
      `Email: ${read("email") || "(not given)"}`,
      `Business: ${business || "(not given)"}`,
      `Plan of interest: ${read("plan")}`,
      `System: ${read("system")}`,
      "",
      read("message") || "(no message)",
    ].join("\n");

    window.location.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(
      subject,
    )}&body=${encodeURIComponent(body)}`;
    setSent(true);
  }

  const field =
    "w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20 dark:border-slate-700 dark:bg-slate-950 dark:text-white";
  const label = "mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300";

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-lg shadow-slate-200/50 dark:border-slate-800 dark:bg-slate-900 dark:shadow-none">
      <form action={compose} className="space-y-5">
        <label className="block">
          <span className={label}>Full name</span>
          <input name="name" required placeholder="Jane Doe" className={field} />
        </label>

        <label className="block">
          <span className={label}>Email</span>
          <input
            name="email"
            type="email"
            required
            placeholder="jane@yourbusiness.com"
            className={field}
          />
        </label>

        <label className="block">
          <span className={label}>Business name</span>
          <input name="business" placeholder="Acme LLC" className={field} />
        </label>

        <label className="block">
          <span className={label}>Plan you&rsquo;re interested in</span>
          <select name="plan" defaultValue={PLAN_OPTIONS[1]} className={field}>
            {PLAN_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
            <option value="Not sure yet">Not sure yet</option>
          </select>
        </label>

        <label className="block">
          <span className={label}>Which system should your books live in?</span>
          <select name="system" defaultValue="Not sure yet" className={field}>
            <option>The GAMIBOOK system (+{PLATFORM_ADDON_PRICE}/month)</option>
            <option>My own QuickBooks</option>
            <option>My own Xero, FreshBooks or Wave</option>
            <option>Not sure yet</option>
          </select>
        </label>

        <label className="block">
          <span className={label}>How can we help?</span>
          <textarea
            name="message"
            rows={4}
            placeholder="Tell us about your business and what you need…"
            className={field}
          />
        </label>

        <button
          type="submit"
          className="w-full rounded-lg bg-brand-600 px-4 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-brand-700"
        >
          Request Free Consultation
        </button>

        <p
          className="min-h-[1.25rem] text-center text-xs leading-relaxed text-slate-500 dark:text-slate-400"
          role="status"
        >
          {sent
            ? `Your mail app should be open with the message ready — press send and it reaches ${CONTACT_EMAIL}.`
            : "This opens your email app with the message composed. Nothing is sent until you press send there."}
        </p>
      </form>
    </div>
  );
}
