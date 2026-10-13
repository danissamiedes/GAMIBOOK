import type { MetadataRoute } from "next";
import { PUBLIC_PATHS, siteUrl } from "@/lib/seo";

/**
 * Everything is private unless it is listed as public (SPEC §16).
 *
 * The blocklist version of this file would need editing every time a screen is
 * added, and the day somebody forgets is the day `/invoices` turns up in a
 * search result. `Disallow: /` with a short allow-list inverts that: a new app
 * route is out of the index by default, and only a deliberate addition to
 * PUBLIC_PATHS puts it in.
 *
 * `/_next/` is allowed because a crawler that cannot fetch the CSS and
 * JavaScript renders the page as unstyled soup and judges it accordingly.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/$", ...PUBLIC_PATHS.filter((path) => path !== "/"), "/_next/", "/favicon.ico"],
      disallow: "/",
    },
    sitemap: `${siteUrl()}/sitemap.xml`,
  };
}
