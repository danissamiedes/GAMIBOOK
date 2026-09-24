import Link from "next/link";
import { pageTitle } from "@/lib/brand";
import { TERMS, TERMS_EFFECTIVE, TERMS_VERSION } from "@/lib/billing/terms";

export const metadata = {
  title: pageTitle("Terms of Service"),
  description: "The terms covering use of the GAMIBOOK accounting software.",
};

/** Public, and linked from signup — where it has to be readable before agreeing. */
export default function TermsPage() {
  return (
    <main className="mx-auto max-w-2xl px-4 py-14">
      <Link href="/" className="text-lg font-bold tracking-tight">
        <span className="text-slate-900 dark:text-white">GAMI</span>
        <span className="text-brand-600 dark:text-brand-400">BOOK</span>
      </Link>

      <h1 className="mt-8 text-3xl font-bold tracking-tight text-slate-900 dark:text-white">
        Terms of Service
      </h1>
      <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
        Version {TERMS_VERSION} · Effective {TERMS_EFFECTIVE}
      </p>

      <div className="mt-10 space-y-9">
        {TERMS.map((section, index) => (
          <section key={section.heading}>
            <h2 className="mb-3 font-bold text-slate-900 dark:text-white">
              {index + 1}. {section.heading}
            </h2>
            <div className="space-y-3">
              {section.paragraphs.map((paragraph) => (
                <p
                  key={paragraph.slice(0, 40)}
                  className="leading-relaxed text-slate-700 dark:text-slate-300"
                >
                  {paragraph}
                </p>
              ))}
            </div>
          </section>
        ))}
      </div>

      <p className="mt-12 border-t border-slate-200 pt-6 text-sm dark:border-slate-800">
        <Link href="/" className="text-brand-700 underline dark:text-brand-400">
          Back to GAMIBOOK
        </Link>
      </p>
    </main>
  );
}
