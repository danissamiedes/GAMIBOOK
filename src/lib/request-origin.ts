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
  const host =
    firstValue(source.get("x-forwarded-host") ?? source.get("host")) ??
    "localhost:3000";
  const protocol =
    firstValue(source.get("x-forwarded-proto")) ??
    (isLoopback(host) ? "http" : "https");
  return `${protocol}://${host}`;
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
