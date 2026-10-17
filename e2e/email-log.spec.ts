import { expect, test } from "@playwright/test";
import { signIn } from "./helpers";

/**
 * The email log's filters (SPEC §10). What this guards is that filtering is a
 * URL: the list has to survive a reload and a shared link, and applying one
 * filter must not clear the others.
 */
test("filters the log by period, name, address and subject", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "owner@example.com");

  await page.goto("/email-log");
  await expect(page.getByRole("heading", { name: "Email log" })).toBeVisible();

  // Every filter is on the screen whether or not this company has sent
  // anything — an empty log that cannot be searched is the thing to catch.
  for (const box of ["Name", "Sent to", "Subject contains"]) {
    await expect(page.getByRole("searchbox", { name: box })).toBeVisible();
  }
  // The Name column only exists when there are rows to put in it. Both
  // states are correct; which one this company is in depends on the seed.
  if (await page.locator("table").count()) {
    await expect(page.getByRole("columnheader", { name: "Name" })).toBeVisible();
  }

  // A subject that matches nothing says so, and offers the way back.
  await page.getByRole("searchbox", { name: "Subject contains" }).fill("zzz-no-such-subject");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/subject=zzz-no-such-subject/);
  await expect(page.getByText("No messages match these filters")).toBeVisible();

  // Filters travel together: adding a name keeps the subject in the URL.
  await page.getByRole("searchbox", { name: "Name" }).fill("someone");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/subject=zzz-no-such-subject/);
  await expect(page).toHaveURL(/name=someone/);

  // And clearing puts the whole log back.
  await page.getByRole("link", { name: "Show the whole log" }).click();
  await expect(page).toHaveURL(/\/email-log$/);
});

test("the period filter keeps the other filters", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "owner@example.com");

  await page.goto("/email-log?sentTo=example");
  await expect(page.getByRole("searchbox", { name: "Sent to" })).toHaveValue("example");

  // Choosing a fixed period submits on its own; the address must survive it.
  await page.locator("select[name='period']").selectOption("month");
  await expect(page).toHaveURL(/period=month/);
  await expect(page).toHaveURL(/sentTo=example/);
});

test("shows and filters by the name a message was sent under", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, "owner@example.com");

  // The seeded books that actually hold sent mail. Switching company is the
  // only way to reach them, and the switcher is how a user would do it.
  await page.goto("/dashboard");
  const switcher = page.getByRole("combobox", { name: "Active company" });
  const pickle = await switcher
    .locator("option")
    .filter({ hasText: "PICKLE FARM" })
    .first()
    .getAttribute("value");
  test.skip(!pickle, "This seed has no Pickle Farm book");
  await switcher.selectOption(pickle!);
  // The switcher writes a cookie through a server action and refreshes;
  // navigating before that lands would read the old company's books.
  await expect(switcher).toHaveValue(pickle!);
  await expect(switcher).toBeEnabled();

  await page.goto("/email-log");
  await expect(page.getByRole("heading", { name: "Email log" })).toBeVisible();
  const names = page.locator("tbody tr td:nth-child(2)");
  test.skip((await names.count()) === 0, "This book has sent nothing");

  // Every row names whoever the message was about, and the name is a link
  // that filters the log down to them.
  const first = (await names.first().innerText()).trim();
  expect(first).not.toBe("—");
  await names.first().getByRole("link").click();
  await expect(page).toHaveURL(/name=/);
  for (const cell of await names.allInnerTexts()) {
    expect(cell.trim().toLowerCase()).toContain(first.toLowerCase());
  }
});
