import { APP_NAME } from "@/lib/brand";
import { CONTACT_EMAIL, OWNER_NAME, SERVICES } from "@/components/marketing/content";

/**
 * What search engines are told about this site (SPEC §16).
 *
 * Two audiences share one domain: strangers who might hire the practice, and
 * the people who already have and are signed in. Only the first should ever
 * appear in a search result — an indexed `/invoices` is a page nobody outside
 * can open, and it dilutes what the site is understood to be about.
 *
 * The public set is listed here once and used by both the sitemap and
 * robots.txt, so a new app screen is private by default rather than by
 * somebody remembering to add it to a blocklist.
 */

/** Where the site actually lives. Overridable so previews describe themselves. */
export function siteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (configured) return configured.replace(/\/+$/, "");
  const vercel = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercel) return `https://${vercel}`;
  return "https://gamibook.com";
}

/** Paths a search engine is welcome to index. Everything else is the app. */
export const PUBLIC_PATHS = ["/", "/terms", "/signup", "/book/"] as const;

export const SITE_DESCRIPTION =
  "Accurate, on-time bookkeeping for small businesses and entrepreneurs — monthly bookkeeping, reconciliation, financial reporting and payroll support. Work on the GAMIBOOK system or the QuickBooks you already use.";

/**
 * The practice, as structured data.
 *
 * `ProfessionalService` rather than `LocalBusiness`: the work is done remotely
 * for clients wherever they are, so there is no shopfront to give an address
 * for, and claiming one would be a lie a search engine is entitled to act on.
 *
 * The testimonials on the page are deliberately **not** marked up. Reviews a
 * business publishes about itself are not eligible for review rich results, and
 * marking them up as though they were is the kind of thing that earns a manual
 * penalty rather than a star rating.
 */
export function organizationJsonLd() {
  const url = siteUrl();
  return {
    "@context": "https://schema.org",
    "@type": "ProfessionalService",
    "@id": `${url}/#organization`,
    name: APP_NAME,
    url,
    email: CONTACT_EMAIL,
    description: SITE_DESCRIPTION,
    founder: { "@type": "Person", name: OWNER_NAME },
    // Remote practice: the service area is where the clients are, not where
    // the desk is.
    areaServed: { "@type": "Country", name: "United States" },
    availableLanguage: "English",
    knowsAbout: [
      "Bookkeeping",
      "Bank reconciliation",
      "Financial reporting",
      "Accounts payable and receivable",
      "Payroll support",
      "QuickBooks",
      "Xero",
    ],
    hasOfferCatalog: {
      "@type": "OfferCatalog",
      name: "Bookkeeping services",
      itemListElement: SERVICES.map((service) => ({
        "@type": "Offer",
        itemOffered: {
          "@type": "Service",
          name: service.title,
          description: service.body,
        },
      })),
    },
  };
}
