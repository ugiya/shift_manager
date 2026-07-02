import { test, expect, Page } from "@playwright/test";

// Round 5 (2026-07-02) UI-clarity feedback: the project picker (one project at a time),
// the plain-words score badge with its legend, the simplified workload tab, and
// Hebrew-composed review flags (configured names stay as entered).

async function solve(page: Page) {
  await page.goto("/");
  await page.getByTestId("solve-button").click();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true", { timeout: 40000 });
}

test("the project view shows one project at a time via the picker", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("project-picker")).toBeVisible();
  // Default: the FIRST project only — no more scrolling through the whole portfolio.
  await expect(page.getByTestId("project-section")).toHaveCount(1);
  await expect(page.getByTestId("project-section")).toHaveAttribute("data-project-id", "proj-apollo");

  await page.locator('[data-testid=project-pick][data-project-id="proj-borealis"]').click();
  await expect(page.getByTestId("project-section")).toHaveCount(1);
  await expect(page.getByTestId("project-section")).toHaveAttribute("data-project-id", "proj-borealis");

  // "All" restores the old everything-at-once mode.
  await page.getByTestId("project-pick-all").click();
  expect(await page.getByTestId("project-section").count()).toBeGreaterThan(1);
});

test("the picked project survives a reload (session UI state)", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-06-24T12:00:00")); // stay in the pinned week
  await page.goto("/");
  await page.locator('[data-testid=project-pick][data-project-id="proj-borealis"]').click();
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem("shift-scheduler:session:v1");
    return raw ? JSON.parse(raw).ui?.projectId : null;
  })).toBe("proj-borealis");
  await page.reload();
  await expect(page.getByTestId("project-section")).toHaveAttribute("data-project-id", "proj-borealis");
});

test("the workload tab is simple by default; Advanced reveals the fairness numbers", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("sidetab-workload").click();
  await expect(page.getByTestId("workload-panel")).toBeVisible();
  // employee · shifts · nights · weekends — no burden/vs-team columns
  await expect(page.locator(".workload__table thead th")).toHaveCount(4);
  await page.getByTestId("workload-advanced").click();
  await expect(page.locator(".workload__table thead th")).toHaveCount(6);
  await page.getByTestId("workload-advanced").click();
  await expect(page.locator(".workload__table thead th")).toHaveCount(4);
});

test("the score badge speaks plainly: amber while shifts are empty, green when full", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-state", "idle");

  // One manual assignment → legal but nearly everything empty → amber, in words.
  await page.getByTestId("viewby-team").click();
  await page.getByTestId("roster-assign").first().click();
  await page.getByTestId("roster-assign-option").first().click();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-state", "warn");
  await expect(page.getByTestId("score-badge")).toContainText("empty shifts");
  // No raw score jargon on the badge anymore.
  await expect(page.getByTestId("score-badge")).not.toContainText("penalty");

  // The "?" legend explains the states.
  await page.getByTestId("score-legend-button").click();
  await expect(page.getByTestId("score-legend")).toBeVisible();
  await page.getByTestId("score-legend-button").click();
  await expect(page.getByTestId("score-legend")).toHaveCount(0);

  // A full solve fills every seat → green "All good".
  await page.getByTestId("solve-button").click();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-state", "ok", { timeout: 40000 });
  await expect(page.getByTestId("score-badge")).toContainText("All good");
});

test("switching language never resets the working schedule", async ({ page }) => {
  // Regression (round 5): a t()-dependent callback chain made the language toggle
  // re-run the initial seed fetch, clobbering the working document and assignments.
  await page.goto("/");
  await page.getByTestId("viewby-team").click();
  await page.getByTestId("roster-assign").first().click();
  await page.getByTestId("roster-assign-option").first().click();
  await expect(page.getByTestId("roster-chip")).toHaveCount(1);
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-state", "warn");

  await page.getByTestId("lang-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.waitForTimeout(1200); // past the (would-be) rebuild debounce + build
  await expect(page.getByTestId("roster-chip")).toHaveCount(1);
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-state", "warn");
});

test("review flags render in Hebrew, keeping configured names as entered", async ({ page }) => {
  await solve(page);
  await page.getByTestId("lang-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  const flags = page.getByTestId("flag");
  expect(await flags.count()).toBeGreaterThan(0); // the seed solve reports compromises
  // Every flag title is COMPOSED Hebrew (static words translated)…
  await expect(flags.first().locator(".flag__title")).toHaveText(/[֐-׿]/);
  // …while a configured name (an employee, as entered in the org) stays untranslated.
  await expect(flags.first().locator(".flag__title")).toHaveText(/[A-Za-z]/);

  // Back to English: the backend's original prose returns.
  await page.getByTestId("lang-toggle").click();
  await expect(flags.first().locator(".flag__title")).not.toHaveText(/[֐-׿]/);
});
