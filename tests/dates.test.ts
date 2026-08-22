import { describe, expect, it } from "vitest";
import {
  formatAccountingDate,
  isoDate,
  parseAccountingDate,
  today,
} from "@/lib/dates";

const AUG = new Date(Date.UTC(2026, 7, 5)); // 5 August 2026

/**
 * Two renderings that must not be confused. The display one is what people
 * read; the ISO one is what inputs, URLs, filenames and hashes depend on, and
 * a slip between them fails silently — an empty date picker, a query param
 * that falls back to its default, a dedupe hash that matches nothing.
 */
describe("date formatting", () => {
  it("shows a date as mm/dd/yyyy, zero-padded", () => {
    expect(formatAccountingDate(AUG)).toBe("08/05/2026");
    expect(formatAccountingDate(new Date(Date.UTC(2026, 11, 31)))).toBe("12/31/2026");
    expect(formatAccountingDate(new Date(Date.UTC(2026, 0, 1)))).toBe("01/01/2026");
  });

  it("keeps the machine format as yyyy-mm-dd", () => {
    expect(isoDate(AUG)).toBe("2026-08-05");
    expect(isoDate(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-01-01");
  });

  it("round-trips through the machine format, which is what inputs submit", () => {
    for (const date of [AUG, today(), new Date(Date.UTC(2027, 1, 28))]) {
      expect(parseAccountingDate(isoDate(date))?.getTime()).toBe(date.getTime());
    }
  });

  it("does not accept the display format where the machine one is required", () => {
    // Not a limitation to fix: a date input always submits ISO, and accepting
    // both here would hide a call site using the wrong one.
    expect(parseAccountingDate("08/05/2026")).toBeNull();
  });

  it("is unaffected by the machine's own time zone", () => {
    // Stored at UTC midnight, so Manila and New York read the same day.
    const midnight = new Date(Date.UTC(2026, 7, 5, 0, 0, 0));
    expect(formatAccountingDate(midnight)).toBe("08/05/2026");
    expect(isoDate(midnight)).toBe("2026-08-05");
  });
});
