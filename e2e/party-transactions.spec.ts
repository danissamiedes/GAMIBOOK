import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * A party's record has two faces (SPEC §6): what we have had from them, which
 * is why anybody clicks a name, and the fields that describe them. The tab is
 * in the address, so the one being read survives a reload and a save.
 */
const PAGES = [
  { label: "vendor", list: "/vendors", prefix: "/vendors/" },
  { label: "consultant", list: "/consultants", prefix: "/consultants/" },
];

const NAME_FIELD = { role: "textbox" as const, name: "Name", exact: true };

for (const subject of PAGES) {
  test(`a ${subject.label}'s transactions open first, filter by period and export`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await signIn(page, "owner@example.com");

    await page.goto(subject.list);
    // The first link to a record, not the "New …" link beside it.
    await page
      .locator(`main a[href^='${subject.prefix}']:not([href$='/new'])`)
      .first()
      .click();

    // Transactions is what the page opens on.
    await expect(page.getByRole("tab", { name: /Transactions/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByText("Total billed")).toBeVisible();
    await expect(page.getByRole(NAME_FIELD.role, NAME_FIELD)).toHaveCount(0);

    // The way into a document is its reference, never its date.
    const dates = page.locator("tbody td:first-child a");
    await expect(dates).toHaveCount(0);
    const firstLink = page.locator("tbody a").first();
    if (await firstLink.count()) {
      await firstLink.click();
      // Whatever the document is, it opens somewhere that is not this tab.
      await expect(page).not.toHaveURL(new RegExp(`${subject.prefix}[a-z0-9]+$`));
      await page.goBack();
    }

    // A period narrows the rows, and says so in the address.
    await page.getByRole("link", { name: "This year" }).click();
    await expect(page).toHaveURL(/from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}/);
    await expect(page.getByRole("link", { name: "All dates" })).toBeVisible();

    // And the same view comes out as a spreadsheet.
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "Export to Excel" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^Transactions-.*\.xlsx$/);

    // Details is a deliberate click away, and still holds the form.
    await page.getByRole("tab", { name: "Details" }).click();
    await expect(page).toHaveURL(/tab=details/);
    await expect(page.getByRole(NAME_FIELD.role, NAME_FIELD)).toBeVisible();
  });
}
