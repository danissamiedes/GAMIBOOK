import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * A party's record has two faces (SPEC §6): what they are, and what we have
 * had from them. Both pages carry the same pair of tabs, and the tab is in
 * the address, so the one being read survives a reload.
 */
const PAGES = [
  { label: "vendor", list: "/vendors", prefix: "/vendors/" },
  { label: "consultant", list: "/consultants", prefix: "/consultants/" },
];

for (const subject of PAGES) {
  test(`a ${subject.label}'s transactions are a tab on their page`, async ({ page }) => {
    test.setTimeout(120_000);
    await signIn(page, "owner@example.com");

    await page.goto(subject.list);
    // The first link to a record, not the "New …" link beside it.
    await page
      .locator(`main a[href^='${subject.prefix}']:not([href$='/new'])`)
      .first()
      .click();

    // Details is what the page opens on, as it always has.
    await expect(page.getByRole("tab", { name: "Details" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();

    await page.getByRole("tab", { name: /Transactions/ }).click();
    await expect(page).toHaveURL(/tab=transactions/);
    await expect(page.getByRole("tab", { name: /Transactions/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // The totals a reader comes for, and no edit form in sight.
    await expect(page.getByText("Total billed")).toBeVisible();
    await expect(page.getByText("Still owed").first()).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toHaveCount(0);

    // And back again.
    await page.getByRole("tab", { name: "Details" }).click();
    await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeVisible();
  });
}
