import { describe, expect, it } from "vitest";
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
