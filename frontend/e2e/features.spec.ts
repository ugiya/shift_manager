import { test, expect, Page } from "@playwright/test";
import * as fs from "fs";

// Schedule export (print view + assignments CSV), the workload summary tab, and the
// removable carry-over seed.

async function solve(page: Page) {
  await page.goto("/");
  await page.getByTestId("solve-button").click();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true", { timeout: 40000 });
}

test("the schedule CSV lists every seat with assignment status", async ({ page }) => {
  await page.goto("/");
  // one assignment so the file shows both a filled row and UNFILLED gaps
  await page.getByTestId("viewby-team").click();
  await page.getByTestId("roster-assign").first().click();
  await page.getByTestId("roster-assign-option").first().click();
  await expect(page.getByTestId("roster-chip")).toHaveCount(1);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-schedule-csv").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^schedule-\d{4}-\d{2}-\d{2}\.csv$/);
  const content = fs.readFileSync((await download.path())!, "utf-8");
  const lines = content.trim().split("\n");
  expect(lines[0]).toBe("date,day,site,team,shift,start,end,seat,project,role,employee_id,employee,status");
  expect(lines.length).toBeGreaterThan(10);                       // one row per seat
  expect(content).toContain("UNFILLED");                          // gaps are information
  expect(content).toMatch(/,(filled|exceptional)\n/);             // the assignment we made
  expect(content).toContain("shift manager");                     // manager seats included
});

test("the print view renders the whole week for print media only", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("viewby-site")).toBeVisible();    // app loaded + built

  // hidden on screen…
  await expect(page.getByTestId("print-schedule")).toBeHidden();
  // …visible (and complete) under print media
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("print-schedule")).toBeVisible();
  await expect(page.locator(".print__title")).toContainText("Schedule — week of");
  expect(await page.locator(".print__team").count()).toBeGreaterThan(0);
  // while printing, the interactive app chrome is gone
  await expect(page.getByTestId("view-by")).toBeHidden();
  await page.emulateMedia({ media: "screen" });
  await expect(page.getByTestId("print-schedule")).toBeHidden();
});

test("the workload tab summarises per-employee load after a solve", async ({ page }) => {
  await solve(page);
  await page.getByTestId("sidetab-workload").click();
  const rows = page.getByTestId("workload-row");
  expect(await rows.count()).toBeGreaterThan(0);

  // a solved schedule assigns real shifts — someone works something
  const shifts = await rows.evaluateAll((els) =>
    els.map((el) => parseInt(el.getAttribute("data-shifts") ?? "0", 10)));
  expect(shifts.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);

  // heaviest-first ordering by cumulative burden
  const burdens = await rows.evaluateAll((els) =>
    els.map((el) => parseInt(el.getAttribute("data-burden") ?? "0", 10)));
  const sorted = [...burdens].sort((a, b) => b - a);
  expect(burdens).toEqual(sorted);

  // switching back restores the review (flags) panel
  await page.getByTestId("sidetab-review").click();
  await expect(page.getByTestId("flags-panel")).toBeVisible();
});

test("the applied carry-over seed can be removed without a full reset", async ({ page }) => {
  await solve(page);
  await page.getByTestId("carry-button").click();
  await expect(page.getByTestId("seeded-tag")).toBeVisible();

  await page.getByTestId("remove-seed").click();
  await expect(page.getByTestId("seeded-tag")).toHaveCount(0);
  // the week rebuilds from the document's own carry-over fields — still usable
  await expect(page.getByTestId("solve-button")).toBeEnabled({ timeout: 15000 });
});
