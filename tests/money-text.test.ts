import { describe, expect, it } from "vitest";
import { centsToMoneyText, moneyTextToCents, normaliseMoneyText } from "@/lib/money-text";
import { parseMoney } from "@/lib/money";

/**
 * The browser shows a running total for a payment before it is posted, and the
 * server decides what is actually recorded. If those two disagree about what
 * "1,234.56" means, the figure someone approves is not the figure that leaves
 * the bank. They share this module so they cannot drift; these tests hold the
 * shared rules and check the two agree.
 */
describe("money text", () => {
  const cases: [string, string | null][] = [
    ["1522.00", "1522.00"],
    ["1,234.56", "1234.56"],
    ["  42 ", "42"],
    ["PHP 1,000.00", "1000.00"],
    ["₱250", "250"],
    ["(3,000.00)", "-3000.00"],
    ["-15.50", "-15.50"],
    // A sign outside parentheses is not a convention anyone uses; both
    // implementations reject it, which is the point of listing it here.
    ["-(20)", null],
    ["", null],
    ["   ", null],
    ["abc", null],
    [".", null],
    ["1.2.3", null],
  ];

  it("normalises typed text the way the server does", () => {
    for (const [input, expected] of cases) {
      expect(normaliseMoneyText(input), `normalise ${JSON.stringify(input)}`).toBe(expected);
    }
  });

  it("agrees with parseMoney on every one of them", () => {
    for (const [input, expected] of cases) {
      const parsed = parseMoney(input);
      if (expected === null) {
        expect(parsed, `parseMoney ${JSON.stringify(input)}`).toBeNull();
      } else {
        expect(parsed?.toString(), `parseMoney ${JSON.stringify(input)}`).toBe(
          Number(expected).toString(),
        );
      }
    }
  });

  it("converts to whole cents", () => {
    expect(moneyTextToCents("1522.00")).toBe(152200);
    expect(moneyTextToCents("0.05")).toBe(5);
    expect(moneyTextToCents("1,234.56")).toBe(123456);
    expect(moneyTextToCents("42")).toBe(4200);
    expect(moneyTextToCents("(3,000.00)")).toBe(-300000);
    expect(moneyTextToCents("abc")).toBeNull();
  });

  /**
   * More than two decimals is not a cent amount. Rounding it here would show a
   * total that quietly differs from what the server records, so it counts as
   * unreadable and the total says nothing rather than something wrong.
   */
  it("refuses sub-cent precision rather than rounding it", () => {
    expect(moneyTextToCents("1.005")).toBeNull();
    expect(moneyTextToCents("0.001")).toBeNull();
  });

  /**
   * The reason totals are accumulated in cents: 0.1 + 0.2 is not 0.3 in
   * floating point, and a payment total that is off by a hundredth is wrong.
   */
  it("sums without floating-point drift", () => {
    const cents = ["0.10", "0.20", "1522.00", "1000.00", "0.07"]
      .map((text) => moneyTextToCents(text) ?? 0)
      .reduce((total, value) => total + value, 0);
    expect(centsToMoneyText(cents)).toBe("2522.37");
    // The same sum as floats, for contrast.
    expect(0.1 + 0.2 + 1522.0 + 1000.0 + 0.07).not.toBe(2522.37);
  });

  it("round-trips through cents and back", () => {
    for (const text of ["0.00", "0.05", "1522.00", "123456.78", "-3000.00"]) {
      expect(centsToMoneyText(moneyTextToCents(text)!)).toBe(text);
    }
  });
});
