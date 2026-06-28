import { test, expect, Page } from "@playwright/test";

const SITES = [
  { id: "site-ta", name: "Tel Aviv HQ", teams: 2 },
  { id: "site-hf", name: "Haifa Plant", teams: 2 },
  { id: "site-jm", name: "Jerusalem Office", teams: 1 },
  { id: "site-bs", name: "Beersheba Lab", teams: 1 },
];

const ALPHA_SUN_QA = "seat-shift-team-alpha-st-morning-2026-06-21-proj-apollo-role-qa-0";

async function solve(page: Page) {
  await page.getByTestId("solve-button").click();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true");
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("presolve-hint")).toBeVisible();
  // Round 2 #3: the default view is now Project; the site tabs live in the Site view.
  await page.getByTestId("viewby-site").click();
});

test("renders exactly four site tabs", async ({ page }) => {
  await expect(page.getByTestId("site-tab")).toHaveCount(4);
  for (const s of SITES) {
    await expect(page.locator(`[data-testid=site-tab][data-site-id="${s.id}"]`)).toContainText(s.name);
  }
});

test("first site is active by default", async ({ page }) => {
  await expect(page.locator('[data-testid=site-tab][data-site-id="site-ta"]')).toHaveAttribute("data-active", "true");
});

for (const s of SITES) {
  test(`switching to ${s.name} shows its ${s.teams} team(s)`, async ({ page }) => {
    await page.locator(`[data-testid=site-tab][data-site-id="${s.id}"]`).click();
    await expect(page.locator(`[data-testid=site-tab][data-site-id="${s.id}"]`)).toHaveAttribute("data-active", "true");
    await expect(page.getByTestId("team-section")).toHaveCount(s.teams);
  });
}

test("solving staffs every site; switching tabs keeps the global score", async ({ page }) => {
  await solve(page);
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-filled", "135");
  for (const s of SITES) {
    await page.locator(`[data-testid=site-tab][data-site-id="${s.id}"]`).click();
    // the global badge is unchanged regardless of which site is shown
    await expect(page.getByTestId("score-badge")).toHaveAttribute("data-filled", "135");
    // and every seat visible for this site is filled
    await expect(page.locator('[data-testid=seat][data-state="unfilled"]')).toHaveCount(0);
  }
});

test("a site tab shows an issue count when that site has an unfilled seat", async ({ page }) => {
  await solve(page);
  // clear a Tel Aviv seat -> Tel Aviv tab should surface a count
  await page.getByTestId(`seat-select-${ALPHA_SUN_QA}`).selectOption("");
  const taTab = page.locator('[data-testid=site-tab][data-site-id="site-ta"]');
  await expect(taTab.getByTestId("site-issue-count")).toBeVisible();
  await expect(taTab.getByTestId("site-issue-count")).toHaveText("1");
  // other sites have no issues
  await expect(page.locator('[data-testid=site-tab][data-site-id="site-bs"]').getByTestId("site-issue-count")).toHaveCount(0);
});
