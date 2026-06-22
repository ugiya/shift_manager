import { test, expect, Page } from "@playwright/test";

// Deterministic ids from the seed dataset (backend/app/data.py)
const SAT = "2026-06-27";
const SUN = "2026-06-21";
const BRAVO_SAT_SUPPORT = `seat-shift-team-bravo-st-morning-${SAT}-proj-cobalt-role-support-0`;
const ALPHA_SUN_QA = `seat-shift-team-alpha-st-morning-${SUN}-proj-apollo-role-qa-0`;

async function solve(page: Page) {
  await page.getByTestId("solve-button").click();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("presolve-hint")).toBeVisible();
});

test("loads the dataset and renders the first site's teams with seats", async ({ page }) => {
  // default site (Tel Aviv HQ) has two teams
  await expect(page.getByTestId("team-section")).toHaveCount(2);
  const seats = page.getByTestId("seat");
  expect(await seats.count()).toBeGreaterThan(40);
  // before solving, every seat is unfilled
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "unknown");
});

test("solving fills the whole week and reports compromises, no infeasibilities", async ({ page }) => {
  await solve(page);
  const badge = page.getByTestId("score-badge");
  await expect(badge).toHaveAttribute("data-filled", "135");
  await expect(badge).toHaveAttribute("data-total", "135");
  // hard core respected
  await expect(page.getByTestId("count-hard")).toHaveText("0");
  // best-effort optimizer surfaces at least one compromise, never hides them
  const soft = parseInt((await page.getByTestId("count-soft").textContent()) || "0", 10);
  expect(soft).toBeGreaterThanOrEqual(1);
  // no seat is left unfilled or exceptional in the generated schedule
  await expect(page.locator('[data-testid=seat][data-state="unfilled"]')).toHaveCount(0);
  await expect(page.locator('[data-testid=seat][data-state="exceptional"]')).toHaveCount(0);
});

test("an ineligible override is flagged as an Exceptional Assignment (needs sign-off)", async ({ page }) => {
  await solve(page);
  // Adam is a developer — putting him in a QA seat exceeds eligibility
  await page.getByTestId(`seat-select-${ALPHA_SUN_QA}`).selectOption("emp-adam");
  const seat = page.locator(`[data-seat-id="${ALPHA_SUN_QA}"]`);
  await expect(seat).toHaveAttribute("data-state", "exceptional");
  await expect(page.locator('[data-testid=flag][data-rule="EXC"]')).toHaveCount(1);
});

test("override re-validates the WHOLE schedule (consecutive-weekend cascade)", async ({ page }) => {
  await solve(page);
  // Rivka worked last weekend (carry-over). Placing her on a weekend shift this
  // week must raise the no-consecutive-weekends compromise anywhere in the week.
  await page.getByTestId(`seat-select-${BRAVO_SAT_SUPPORT}`).selectOption("emp-rivka");
  await expect(page.locator('[data-testid=flag][data-rule="R7"]')).not.toHaveCount(0);
});

test("clearing a filled seat creates an under-staffing (exact-demand) compromise", async ({ page }) => {
  await solve(page);
  await page.getByTestId(`seat-select-${ALPHA_SUN_QA}`).selectOption("");
  const seat = page.locator(`[data-seat-id="${ALPHA_SUN_QA}"]`);
  await expect(seat).toHaveAttribute("data-state", "unfilled");
  await expect(page.locator('[data-testid=flag][data-rule="R4"]')).not.toHaveCount(0);
});
