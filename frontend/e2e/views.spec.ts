import { test, expect, Page } from "@playwright/test";

// Phase 6 + Round 2 #2/#3/#4: the "View by" selector switches the schedule between four views,
// all editable for assignments (Project also edits requirements). Default is Project.

async function solve(page: Page) {
  await page.goto("/");
  await page.getByTestId("solve-button").click();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true", { timeout: 40000 });
}

test("the view-by selector switches between Project / Team / Employee / Site", async ({ page }) => {
  await solve(page);
  await expect(page.getByTestId("view-by")).toBeVisible();

  // The selector lists views in order Project · Team · Employee · Site (Round 2 #3),
  // and no view is "read-only" anymore (Round 2 #2/#4).
  expect(await page.locator(".viewby__btn").allTextContents()).toEqual(["Project", "Team", "Employee", "Site"]);
  await expect(page.getByTestId("readonly-tag")).toHaveCount(0);

  // Project (default): seat grid aggregated by project, with requirement steppers + editable seats.
  await expect(page.getByTestId("project-view")).toBeVisible();
  await expect(page.getByTestId("viewby-project")).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("sitebar")).toHaveCount(0);
  expect(await page.getByTestId("project-section").count()).toBeGreaterThan(0);
  expect(await page.getByTestId("crew-stepper").count()).toBeGreaterThan(0); // requirements editing
  expect(await page.getByTestId("seat").count()).toBeGreaterThan(0);         // assignment via SeatCell

  // Team: people-as-rows roster grouped by team; no sitebar; assignment via the picker (no Site seats).
  await page.getByTestId("viewby-team").click();
  await expect(page.getByTestId("roster-view")).toHaveAttribute("data-mode", "team");
  await expect(page.getByTestId("sitebar")).toHaveCount(0);
  expect(await page.getByTestId("roster-row").count()).toBeGreaterThan(0);
  expect(await page.getByTestId("roster-assign").count()).toBeGreaterThan(0); // editable
  expect(await page.locator(".rochip").count()).toBeGreaterThan(0);           // a solved roster shows shifts

  // Employee: one flat roster of everyone.
  await page.getByTestId("viewby-employee").click();
  await expect(page.getByTestId("roster-view")).toHaveAttribute("data-mode", "employee");
  expect(await page.getByTestId("roster-row").count()).toBeGreaterThan(0);

  // Site: the editable seat grid + the site tab bar.
  await page.getByTestId("viewby-site").click();
  await expect(page.getByTestId("sitebar")).toBeVisible();
  await expect(page.getByTestId("seat").first()).toBeVisible();
});

test("the roster renders empty (but editable) before solving", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("viewby-team").click();
  await expect(page.getByTestId("roster-view")).toBeVisible(); // waits for the initial build
  expect(await page.getByTestId("roster-row").count()).toBeGreaterThan(0);
  await expect(page.locator(".rochip")).toHaveCount(0);        // nothing assigned yet
  expect(await page.getByTestId("roster-assign").count()).toBeGreaterThan(0); // assignable already
});
