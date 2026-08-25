import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { CompanyTheme } from "@prisma/client";
import {
  COMPANY_THEMES,
  isCompanyTheme,
  nextAvailableTheme,
  themeAttribute,
} from "@/lib/company-theme";
import { createCompany } from "@/lib/companies";
import { makeCompanyWithChart, makeUser, prisma, resetDatabase } from "./helpers";

describe("company accents", () => {
  it("offers a colour for every value the database accepts", () => {
    // A theme the picker cannot show is a company nobody can recolour.
    expect(COMPANY_THEMES.map((theme) => theme.value).sort()).toEqual(
      ["AMBER", "BLUE", "GREEN", "PINK", "TEAL", "VIOLET"].sort(),
    );
  });

  it("gives every accent a swatch and a name", () => {
    for (const theme of COMPANY_THEMES) {
      expect(theme.label).toBeTruthy();
      expect(theme.swatch).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("recognises its own values and nothing else", () => {
    expect(isCompanyTheme("GREEN")).toBe(true);
    expect(isCompanyTheme("green")).toBe(false);
    expect(isCompanyTheme("CHARTREUSE")).toBe(false);
  });

  describe("themeAttribute", () => {
    it("says nothing for blue, which is the app's own palette", () => {
      // Emitting "blue" would re-declare the :root colours as a copy that can
      // drift from them.
      expect(themeAttribute("BLUE")).toBeUndefined();
    });

    it("matches the CSS selectors, which are lowercase", () => {
      expect(themeAttribute("GREEN")).toBe("green");
      expect(themeAttribute("PINK")).toBe("pink");
      expect(themeAttribute("VIOLET")).toBe("violet");
    });
  });

  describe("nextAvailableTheme", () => {
    it("starts at blue when nothing is taken", () => {
      expect(nextAvailableTheme([])).toBe("BLUE");
    });

    it("skips what is already in use", () => {
      expect(nextAvailableTheme(["BLUE"])).toBe("GREEN");
      expect(nextAvailableTheme(["BLUE", "GREEN"])).toBe("PINK");
    });

    it("does not care what order they were taken in", () => {
      expect(nextAvailableTheme(["PINK", "BLUE"])).toBe("GREEN");
    });

    it("cycles rather than failing once every accent is used", () => {
      const all = COMPANY_THEMES.map((theme) => theme.value);
      expect(all).toContain(nextAvailableTheme(all));
    });
  });
});

describe("a new company's accent", () => {
  let existing: Awaited<ReturnType<typeof makeCompanyWithChart>>;
  let owner: Awaited<ReturnType<typeof makeUser>>;

  beforeEach(async () => {
    await resetDatabase();
    existing = await makeCompanyWithChart("Bookkeeping Point", "PHP");
    owner = await makeUser("OWNER", existing.company.id);
  });

  afterAll(async () => {
    await resetDatabase();
    await prisma.$disconnect();
  });

  const create = (name: string) =>
    createCompany({
      name,
      baseCurrency: "PHP",
      fiscalYearStartMonth: 1,
      timeClockTimeZone: "Asia/Manila",
      operatingTimeZone: "Asia/Manila",
      userId: owner.id,
    });

  it("differs from the ones already there", async () => {
    // The first company is blue by default, so the second must not be.
    expect(existing.company.theme).toBe("BLUE");

    const second = await create("KASAGAMI Apartments");
    const third = await create("Poise Fitness Studio");

    expect(second.theme).not.toBe(existing.company.theme);
    expect(third.theme).not.toBe(second.theme);
    expect(third.theme).not.toBe(existing.company.theme);
  });

  it("records the accent it chose in the audit trail", async () => {
    const company = await create("KASAGAMI Apartments");
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "company.created", entityId: company.id },
    });
    expect((audit.data as { theme: CompanyTheme }).theme).toBe(company.theme);
    expect(audit.summary).toContain(company.theme.toLowerCase());
  });

  it("only counts the accents of companies this person can see", async () => {
    // Someone else's blue company must not push mine off blue.
    const stranger = await makeUser("OWNER", existing.company.id, "stranger@example.test");
    await prisma.membership.deleteMany({ where: { userId: stranger.id } });

    const theirs = await createCompany({
      name: "Their Books",
      baseCurrency: "PHP",
      fiscalYearStartMonth: 1,
      timeClockTimeZone: "Asia/Manila",
      operatingTimeZone: "Asia/Manila",
      userId: stranger.id,
    });
    expect(theirs.theme).toBe("BLUE");
  });
});
