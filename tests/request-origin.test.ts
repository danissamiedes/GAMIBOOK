import { afterEach, describe, expect, it } from "vitest";
import { requestOrigin } from "@/lib/request-origin";

const headers = (values: Record<string, string>) => new Headers(values);

describe("requestOrigin", () => {
  it("treats a loopback host as plain HTTP whatever NODE_ENV says", () => {
    // The bug this guards: a production build on localhost used to ask Google
    // for https://localhost:3000, which no console entry matches.
    expect(requestOrigin(headers({ host: "localhost:3000" }))).toBe(
      "http://localhost:3000",
    );
    expect(requestOrigin(headers({ host: "127.0.0.1:3000" }))).toBe(
      "http://127.0.0.1:3000",
    );
    expect(requestOrigin(headers({ host: "[::1]:3000" }))).toBe(
      "http://[::1]:3000",
    );
  });

  it("assumes HTTPS for a real hostname", () => {
    expect(requestOrigin(headers({ host: "ledger.example.com" }))).toBe(
      "https://ledger.example.com",
    );
  });

  it("believes the proxy over the host shape", () => {
    expect(
      requestOrigin(
        headers({
          host: "localhost:3000",
          "x-forwarded-proto": "https",
          "x-forwarded-host": "ledger.example.com",
        }),
      ),
    ).toBe("https://ledger.example.com");
  });

  it("takes the client's own value when a proxy appends rather than replaces", () => {
    expect(
      requestOrigin(
        headers({
          host: "internal:8080",
          "x-forwarded-proto": "https,http",
          "x-forwarded-host": "ledger.example.com, internal:8080",
        }),
      ),
    ).toBe("https://ledger.example.com");
  });

  it("falls back to the dev origin when nothing identifies the host", () => {
    expect(requestOrigin(headers({}))).toBe("http://localhost:3000");
  });
});

/**
 * Vercel sets x-forwarded-host and no plain Host header. Reading Host alone
 * yielded nothing and fell through to the localhost literal, which is how
 * invitation links to a live deployment came out pointing at a dev machine.
 */
describe("a host that sets only the forwarded header", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("uses x-forwarded-host when there is no Host header at all", () => {
    const origin = requestOrigin(
      new Headers({ "x-forwarded-host": "gamibook.vercel.app", "x-forwarded-proto": "https" }),
    );
    expect(origin).toBe("https://gamibook.vercel.app");
  });

  it("falls back to AUTH_URL's host rather than localhost when neither header is set", () => {
    process.env.AUTH_URL = "https://books.example.com";
    expect(requestOrigin(new Headers({}))).toBe("https://books.example.com");
  });

  it("falls back to VERCEL_URL when AUTH_URL is not configured", () => {
    delete process.env.AUTH_URL;
    delete process.env.NEXTAUTH_URL;
    process.env.VERCEL_URL = "gamibook-abc123.vercel.app";
    expect(requestOrigin(new Headers({}))).toBe("https://gamibook-abc123.vercel.app");
  });

  it("ignores a malformed AUTH_URL instead of throwing", () => {
    process.env.AUTH_URL = "not a url";
    delete process.env.NEXTAUTH_URL;
    delete process.env.VERCEL_URL;
    expect(requestOrigin(new Headers({}))).toBe("http://localhost:3000");
  });

  it("still prefers the request's own header over anything configured", () => {
    process.env.AUTH_URL = "https://books.example.com";
    const origin = requestOrigin(
      new Headers({ "x-forwarded-host": "preview.vercel.app", "x-forwarded-proto": "https" }),
    );
    expect(origin).toBe("https://preview.vercel.app");
  });
});
