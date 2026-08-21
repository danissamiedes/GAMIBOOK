/**
 * Paging for list screens.
 *
 * Every list took the first N rows and said nothing about the rest, so a
 * company with two thousand invoices could see two hundred of them and had no
 * way to know the other eighteen hundred existed. A silent truncation on a
 * financial screen is worse than a slow one: the figures on the page are true
 * and the impression they give is false.
 */

export const DEFAULT_PAGE_SIZE = 100;

export type Page = {
  page: number;
  size: number;
  skip: number;
  take: number;
};

export function readPage(
  params: { page?: string; size?: string },
  defaultSize = DEFAULT_PAGE_SIZE,
): Page {
  const requestedSize = Number(params.size);
  // Bounded, so a hand-edited URL cannot ask for every row in the database.
  const size =
    Number.isInteger(requestedSize) && requestedSize > 0
      ? Math.min(requestedSize, 500)
      : defaultSize;
  const requestedPage = Number(params.page);
  const page =
    Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;
  return { page, size, skip: (page - 1) * size, take: size };
}

/**
 * What to say about the rows on screen versus the rows that exist.
 *
 * The plural is given rather than derived: "entrys" and "companys" are what
 * happens when a list screen guesses.
 */
export function pageSummary(
  page: Page,
  total: number,
  noun = "row",
  plural = `${noun}s`,
) {
  const first = total === 0 ? 0 : page.skip + 1;
  const last = Math.min(page.skip + page.size, total);
  const pages = Math.max(1, Math.ceil(total / page.size));
  return {
    first,
    last,
    total,
    pages,
    hasPrevious: page.page > 1,
    hasNext: page.page < pages,
    label:
      total === 0
        ? `No ${plural}`
        : total <= page.size
          ? `${total.toLocaleString()} ${total === 1 ? noun : plural}`
          : `${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()} ${plural}`,
  };
}

/** Build a link to another page, keeping whatever filters are already on. */
export function pageHref(
  basePath: string,
  params: Record<string, string | undefined>,
  page: number,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "" && key !== "page")
      query.set(key, value);
  }
  if (page > 1) query.set("page", String(page));
  const search = query.toString();
  return search ? `${basePath}?${search}` : basePath;
}
