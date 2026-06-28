import { test, expect, Page } from "@playwright/test";

// "Carry to next week" (ADR-0002): solving exposes a next-week carry-over seed;
// clicking Carry advances the week, replays the seed, and the next week still
// solves feasibly and fully — proving the validated seam works end-to-end.

async function solve(page: Page) {
  await page.getByTestId("solve-button").click();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("presolve-hint")).toBeVisible();
});

test("carry-over button is hidden until a schedule is generated", async ({ page }) => {
  await expect(page.getByTestId("carry-button")).toHaveCount(0);
  await expect(page.getByTestId("seeded-tag")).toHaveCount(0);
});

test("saving a requirements change after solving immediately hides the stale carry button", async ({ page }) => {
  await solve(page);
  await expect(page.getByTestId("carry-button")).toBeVisible();
  // Change the org and Save it (Round 2 #1: edits are local until Save): the next-week
  // seed is derived from a schedule that no longer matches, so the Carry button must
  // disappear at once on commit (not after a debounce).
  await page.getByTestId("nav-editor").click();
  await page.getByTestId("add-site").click();
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("carry-button")).toHaveCount(0);
});

test("carrying to next week seeds it and the week still solves feasibly", async ({ page }) => {
  await solve(page);
  // the seed for next week is available
  const carry = page.getByTestId("carry-button");
  await expect(carry).toBeVisible();

  await carry.click();

  // the week advanced (schedule reset) and is now marked seeded
  await expect(page.getByTestId("seeded-tag")).toBeVisible();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "unknown");

  // re-solving the seeded week succeeds, fully staffed — the seed was accepted
  // (a wrong-week seed would have been rejected and surfaced as a blocking error)
  await solve(page);
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-filled", "135");
  await expect(page.getByTestId("blocked-banner")).toHaveCount(0);
  // and the seeded tag persists across the re-solve
  await expect(page.getByTestId("seeded-tag")).toBeVisible();
});
