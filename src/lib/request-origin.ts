/**
 * The origin the browser actually used.
 *
 * Google compares `redirect_uri` as a string: the authorize call and the token
 * exchange must produce the same one, and both must match what is registered
 * in the console. Guessing the scheme from `NODE_ENV` gets that wrong in both
 * directions — a production build served over plain HTTP on localhost asks for
 * `https://localhost:3000`, and a dev build behind a TLS-terminating proxy asks
 * for `http://`. The proxy headers say what the browser used; without them,
 * only a loopback host is assumed to be plain HTTP.
 */
export function requestOrigin(source: Headers): string {
  // x-forwarded-host first, and not merely as a preference: Vercel sets it and
  // sets no plain Host header at all, so reading Host alone yields nothing and
  // whatever default sits behind it — which is how invitation links to a live
  // deployment came out pointing at localhost.
  const forwarded = firstValue(source.get("x-forwarded-host") ?? source.get("host"));
  const host = forwarded ?? configuredHost() ?? "localhost:3000";
  const protocol =
    firstValue(source.get("x-forwarded-proto")) ??
    (isLoopback(host) ? "http" : "https");
  return `${protocol}://${host}`;
}

/**
 * Last resort before the localhost literal: the public URL the operator
 * configured. A host that answers on neither header is unusual, but guessing
 * localhost there produces a link that is confidently wrong rather than
 * obviously broken, and these links are single-use.
 */
function configuredHost(): string | undefined {
  const configured = process.env.AUTH_URL || process.env.NEXTAUTH_URL;
  if (configured) {
    try {
      return new URL(configured).host;
    } catch {
      // A malformed AUTH_URL is not worth throwing over here.
    }
  }
  // Vercel sets this to the deployment's own hostname, without a scheme.
  return process.env.VERCEL_URL || undefined;
}

/** Proxies may append rather than replace, leaving `https,http`. The client's own value is first. */
function firstValue(header: string | null): string | undefined {
  const value = header?.split(",")[0]?.trim();
  return value ? value : undefined;
}

function isLoopback(host: string): boolean {
  const hostname = host.startsWith("[")
    ? host.slice(1, host.indexOf("]"))
    : (host.split(":")[0] ?? host);
  return ["localhost", "127.0.0.1", "::1"].includes(hostname.toLowerCase());
}
