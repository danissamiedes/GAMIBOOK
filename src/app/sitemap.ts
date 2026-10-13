import type { MetadataRoute } from "next";
import { prisma } from "@/lib/db";
import { siteUrl } from "@/lib/seo";

/**
 * The map a crawler works from (SPEC §16).
 *
 * The marketing pages are fixed; the booking pages are not, so published
 * venues are read from the database. A venue that is not published is left out
 * for the same reason its page 404s — it is not open yet.
 *
 * Wrapped in a try/catch on purpose: a sitemap is a convenience, and a database
 * hiccup must not turn it into a 500 that a crawler remembers.
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const url = siteUrl();
  const now = new Date();

  const pages: MetadataRoute.Sitemap = [
    { url: `${url}/`, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${url}/signup`, lastModified: now, changeFrequency: "monthly", priority: 0.5 },
    { url: `${url}/terms`, lastModified: now, changeFrequency: "yearly", priority: 0.2 },
  ];

  try {
    const venues = await prisma.bookingSettings.findMany({
      where: { isPublished: true },
      select: { slug: true },
      take: 500,
    });
    for (const venue of venues) {
      pages.push({
        url: `${url}/book/${venue.slug}`,
        lastModified: now,
        changeFrequency: "daily",
        priority: 0.6,
      });
    }
  } catch {
    // The marketing pages are the ones that matter; a missing venue list is
    // not worth failing the whole document for.
  }

  return pages;
}
