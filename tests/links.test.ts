import { describe, expect, it } from "vitest";
import { linkLabel, safeExternalUrl } from "@/lib/links";

/**
 * The value typed into "File link" is rendered as an href on a page other
 * people load, so what this rejects matters more than what it accepts.
 */
describe("safeExternalUrl", () => {
  it("accepts an ordinary web link", () => {
    expect(safeExternalUrl("https://drive.google.com/file/d/abc/view")).toBe(
      "https://drive.google.com/file/d/abc/view",
    );
    expect(safeExternalUrl("  http://example.test/a.jpg  ")).toBe("http://example.test/a.jpg");
  });

  it("refuses a scheme that would execute", () => {
    for (const nasty of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "  javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
    ]) {
      expect(safeExternalUrl(nasty)).toBeNull();
    }
  });

  it("refuses what is not a URL at all", () => {
    expect(safeExternalUrl("")).toBeNull();
    expect(safeExternalUrl("   ")).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
    expect(safeExternalUrl(undefined)).toBeNull();
    expect(safeExternalUrl("drive.google.com/file")).toBeNull();
  });
});

describe("linkLabel", () => {
  it("names Drive, and otherwise the host", () => {
    expect(linkLabel("https://drive.google.com/file/d/abc/view")).toBe("Drive");
    expect(linkLabel("https://www.dropbox.com/s/abc")).toBe("dropbox.com");
    expect(linkLabel("not a url")).toBe("Link");
  });
});
