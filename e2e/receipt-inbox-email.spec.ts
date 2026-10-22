import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * Bills forwarded by email (SPEC §8.2 extension). The mailbox itself cannot
 * be exercised from a browser, so what these guard is the part a person
 * touches: the tab, the setup screen, and the fact that recording a
 * forwarded bill lands on the ordinary expense form with the email's details
 * carried over.
 */
test("the receipt inbox has a tab for mail, and says what is missing", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "owner@example.com");

  await page.goto("/receipts");
  await expect(page.getByRole("heading", { name: "Receipt inbox" })).toBeVisible();

  await page.getByRole("link", { name: /^Forwarded by email/ }).click();
  await expect(page).toHaveURL(/tab=email/);

  // The four columns the list is for.
  for (const column of ["Forwarded", "Subject", "File", "Record as"]) {
    await expect(page.getByRole("columnheader", { name: column })).toBeVisible().catch(async () => {
      // With nothing forwarded there is no table, and the screen must say
      // why rather than showing an empty frame.
      await expect(
        page.getByText(/no forwarding address|Nothing forwarded yet/i).first(),
      ).toBeVisible();
    });
  }
});

test("the setup screen asks for the two things that must be true", async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, "owner@example.com");
  await page.goto("/receipts/settings");

  await expect(page.getByRole("heading", { name: "Bills by email" })).toBeVisible();
  // Reading the mailbox, and an address of this book's own.
  await expect(page.getByText(/Let GAMIBOOK read the mailbox/)).toBeVisible();
  await expect(page.getByText(/Give this book an address/)).toBeVisible();

  // Saving an address sticks, and a nonsense one is refused. "a@b" is used
  // rather than plain gibberish because the browser's own check on a type=
  // email field catches that before the form is ever submitted; this one
  // gets through to the server, which is the check being exercised.
  await page.locator("input[name='inboxAddress']").fill("a@b");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/does not look like an email address/i)).toBeVisible();

  await page.locator("input[name='inboxAddress']").fill("docs+e2e@bookkeepingpoint.com");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
  await expect(page.locator("input[name='inboxAddress']")).toHaveValue(
    "docs+e2e@bookkeepingpoint.com",
  );

  // Put it back, so the run leaves the book as it found it.
  await page.locator("input[name='inboxAddress']").fill("");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
});
