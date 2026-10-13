import { APP_NAME } from "@/lib/brand";
import { SITE_DESCRIPTION, siteUrl } from "@/lib/seo";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

/**
 * What a search engine and a link preview see (SPEC §16).
 *
 * The description used to be the product's own one-liner, written for whoever
 * was reading the repository. It is the fallback for every page that does not
 * set its own, including the one strangers actually land on, so it says what
 * the practice does instead.
 *
 * `metadataBase` is what makes the rest work: without it, Open Graph images and
 * canonical links resolve as relative paths, which means a shared link shows
 * nothing and two addresses for the same page compete with each other.
 */
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: {
    default: `${APP_NAME} — bookkeeping for growing businesses`,
    template: `%s — ${APP_NAME}`,
  },
  description: SITE_DESCRIPTION,
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: APP_NAME,
    title: `${APP_NAME} — bookkeeping for growing businesses`,
    description: SITE_DESCRIPTION,
    url: "/",
    images: [{ url: "/og.png", width: 1200, height: 630, alt: `${APP_NAME} — your books, handled` }],
  },
  twitter: {
    card: "summary_large_image",
    title: `${APP_NAME} — bookkeeping for growing businesses`,
    description: SITE_DESCRIPTION,
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh bg-slate-50 text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        {children}
      </body>
    </html>
  );
}
