/**
 * A link somebody typed, made safe to render.
 *
 * The value ends up as an `href` on a page other people load, so the scheme
 * has to be checked rather than trusted: `javascript:…` in a field like this
 * is a stored cross-site scripting hole, and it looks like an ordinary link
 * right up until someone clicks it. Only http and https get through.
 */
export function safeExternalUrl(input: string | null | undefined): string | null {
  const trimmed = (input ?? "").trim();
  if (!trimmed) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url.toString();
}

/** Something short enough to sit in a table cell. */
export function linkLabel(url: string): string {
  try {
    const { hostname } = new URL(url);
    const bare = hostname.replace(/^www\./, "");
    return bare === "drive.google.com" ? "Drive" : bare;
  } catch {
    return "Link";
  }
}
