import { test, expect, Page } from "@playwright/test";

const ALPHA_SUN_QA = "seat-shift-team-alpha-st-morning-2026-06-21-proj-apollo-role-qa-0";

async function solve(page: Page) {
  await page.getByTestId("solve-button").click();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("presolve-hint")).toBeVisible();
  // Round 2 #3: the default view is now Project; these tests drive the editable Site grid.
  await page.getByTestId("viewby-site").click();
});

test("each seat select offers unfilled, eligible names, and an exceptional optgroup", async ({ page }) => {
  const info = await page.locator(`[data-testid=seat-select-${ALPHA_SUN_QA}]`).evaluate((el) => {
    const sel = el as HTMLSelectElement;
    const groups = [...sel.querySelectorAll("optgroup")].map((g) => g.label);
    const opts = [...sel.querySelectorAll("option")].map((o) => o.textContent);
    return { firstValue: (sel.querySelector("option") as HTMLOptionElement).value, groups, opts };
  });
  expect(info.firstValue).toBe(""); // "— unfilled —"
  expect(info.groups).toContain("Eligible");
  expect(info.groups.some((g) => g.startsWith("Exceptional"))).toBe(true);
  // Jamie and Maya are the eligible QA people for Apollo
  expect(info.opts).toEqual(expect.arrayContaining(["Jamie", "Maya"]));
});

test("night cells and weekend columns are visually marked", async ({ page }) => {
  // wait for the grid to materialise (requirements -> build is debounced)
  await expect(page.getByTestId("shift-cell").first()).toBeVisible();
  expect(await page.locator(".cell.is-night").count()).toBeGreaterThan(0);
  expect(await page.locator(".grid__dayhdr.is-weekend").count()).toBeGreaterThan(0);
});

test("the pre-solve hint disappears once solved", async ({ page }) => {
  await solve(page);
  await expect(page.getByTestId("presolve-hint")).toHaveCount(0);
});

test("an exceptional assignment shows a sign-off tag on the seat", async ({ page }) => {
  await solve(page);
  await page.getByTestId(`seat-select-${ALPHA_SUN_QA}`).selectOption("emp-adam");
  const seat = page.locator(`[data-seat-id="${ALPHA_SUN_QA}"]`);
  await expect(seat).toHaveAttribute("data-state", "exceptional");
  await expect(seat.locator(".seat__tag--exc")).toBeVisible();
});

test("an eligible override keeps the schedule feasible", async ({ page }) => {
  await solve(page);
  await page.getByTestId(`seat-select-${ALPHA_SUN_QA}`).selectOption("emp-jamie");
  await expect(page.locator(`[data-seat-id="${ALPHA_SUN_QA}"]`)).toHaveAttribute("data-state", "filled");
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true");
});

test("sequential overrides settle to the final choice", async ({ page }) => {
  await solve(page);
  const sel = page.getByTestId(`seat-select-${ALPHA_SUN_QA}`);
  await sel.selectOption("emp-adam"); // exceptional
  await expect(page.locator('[data-testid=flag][data-rule="EXC"]')).toHaveCount(1);
  await sel.selectOption("emp-jamie"); // eligible -> exceptional clears
  await expect(page.locator('[data-testid=flag][data-rule="EXC"]')).toHaveCount(0);
  await expect(page.locator(`[data-seat-id="${ALPHA_SUN_QA}"]`)).toHaveAttribute("data-state", "filled");
});

test("clearing then refilling a seat toggles the under-staffing flag", async ({ page }) => {
  await solve(page);
  const sel = page.getByTestId(`seat-select-${ALPHA_SUN_QA}`);
  await sel.selectOption("");
  await expect(page.locator('[data-testid=flag][data-rule="R4"]')).not.toHaveCount(0);
  await sel.selectOption("emp-jamie");
  await expect(page.locator('[data-testid=flag][data-rule="R4"]')).toHaveCount(0);
});

test("re-solving after manual overrides restores a full, feasible schedule", async ({ page }) => {
  await solve(page);
  await page.getByTestId(`seat-select-${ALPHA_SUN_QA}`).selectOption(""); // break it
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-filled", "134");
  await page.getByTestId("solve-button").click(); // re-solve
  // The badge is ALREADY feasible=true here (an unfilled seat is medium-level coverage,
  // not a hard violation), so data-filled is the only signal that the re-solve response
  // landed — give it the full solve budget, not the 5s default (it flakes under load).
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-filled", "135", { timeout: 40000 });
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true");
});

test("the flags panel lists compromises after solving", async ({ page }) => {
  await solve(page);
  await expect(page.getByTestId("flaggroup-soft")).toBeVisible();
  const soft = parseInt((await page.getByTestId("count-soft").textContent()) || "0", 10);
  expect(soft).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("count-hard")).toHaveText("0");
});
