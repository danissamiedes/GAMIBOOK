"use client";

import { useState } from "react";
import { CONTACT_EMAIL, PLAN_OPTIONS } from "./plans";

/**
 * The enquiry form.
 *
 * It opens the visitor's mail client with the message composed, rather than
 * posting anywhere. That is a deliberate first step, not an oversight: a form
 * that POSTs needs somewhere for leads to land — a table, an inbox, a webhook —
 * and picking that before anyone has asked for a demo is building a feature
 * nobody has needed yet. A mailto works on day one, on a static host, with
 * nothing to maintain and nothing to leak.
 *
 * The cost is real and worth stating: it needs a mail client configured, and
 * an enquiry only exists once the visitor presses send in it. When enquiries
 * start arriving, replace the body of `compose` with a server action.
 */
export function ContactForm() {
  const [sent, setSent] = useState(false);

  function compose(formData: FormData) {
    const business = String(formData.get("business") || "").trim();
    const plan = String(formData.get("plan") || "");
    const message = String(formData.get("message") || "").trim();

    const subject = `GAMIBOOK demo request${business ? ` — ${business}` : ""}`;
    const body = [
      `Business: ${business || "(not given)"}`,
      `Plan of interest: ${plan}`,
      "",
      message || "(no message)",
    ].join("\n");

    window.location.href = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(
      subject,
    )}&body=${encodeURIComponent(body)}`;
    setSent(true);
  }

  const field =
    "w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-600/20 dark:border-slate-700 dark:bg-slate-950 dark:text-white";

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-7 shadow-lg shadow-slate-200/50 dark:border-slate-800 dark:bg-slate-900 dark:shadow-none">
      <form action={compose} className="space-y-5">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
            Business name
          </span>
          <input name="business" required placeholder="Acme Services Inc." className={field} />
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
            Plan you&rsquo;re interested in
          </span>
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
          <span className="mb-1.5 block text-sm font-medium text-slate-700 dark:text-slate-300">
            How can we help?
          </span>
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
          Request a demo
        </button>

        <p
          className="min-h-[1.25rem] text-center text-xs text-slate-500 dark:text-slate-400"
          role="status"
        >
          {sent
            ? `Your mail app should be open with the message ready — press send and it reaches ${CONTACT_EMAIL}.`
            : `This opens your email app with the message composed. Nothing is sent until you press send there.`}
        </p>
      </form>
    </div>
  );
}
