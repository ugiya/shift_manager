import { test, expect, Page } from "@playwright/test";

// Round 2 #2/#4: Project view edits requirements (count steppers + day toggles, draft→Save)
// and assignments (SeatCell, immediate); Team/Employee rosters assign via a seat picker.

const SUN = "2026-06-21";
const ALPHA_SUN_QA = `seat-shift-team-alpha-st-morning-${SUN}-proj-apollo-role-qa-0`;

async function openSchedule(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("presolve-hint")).toBeVisible();
}

// --- #4: person-row assignment editing -------------------------------------------------

test("Employee view: the seat picker assigns a person to a seat, and × removes it", async ({ page }) => {
  await openSchedule(page);
  await page.getByTestId("viewby-employee").click();
  const row = page.locator('[data-testid=roster-row][data-emp-id="emp-jamie"]');
  const sunCell = row.getByTestId("roster-cell").first(); // days[0] = Sunday
  await expect(sunCell.getByTestId("roster-chip")).toHaveCount(0);

  // open the picker; the eligible QA·Apollo·Morning seat is offered first
  await sunCell.getByTestId("roster-assign").click();
  await expect(sunCell.getByTestId("roster-assign-menu")).toBeVisible();
  await sunCell.getByTestId("roster-assign-option").first().click();

  // a chip appears (assignment is immediate) and the schedule re-validates
  await expect(sunCell.getByTestId("roster-chip")).toHaveCount(1);
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true");

  // × removes the person from that shift
  await sunCell.getByTestId("roster-chip").getByTestId("roster-remove").click();
  await expect(sunCell.getByTestId("roster-chip")).toHaveCount(0);
});

// --- #2: Project view requirements + assignment editing --------------------------------

test("Project view: a count stepper edits the requirement as a draft, and Save applies it", async ({ page }) => {
  await openSchedule(page);
  await expect(page.getByTestId("project-view")).toBeVisible(); // default view
  const apollo = page.locator('[data-testid=project-section][data-project-id="proj-apollo"]');
  const count = apollo.getByTestId("project-lane").first().getByTestId("crew-count");
  const before = parseInt((await count.textContent()) || "0", 10);

  // increment: the count updates locally and the unsaved save-bar appears
  await apollo.getByTestId("project-lane").first().getByTestId("crew-inc").click();
  await expect(count).toHaveText(String(before + 1));
  await expect(page.getByTestId("project-savebar")).toBeVisible();

  // Save commits → rebuild; the save-bar clears and the new count is committed
  await page.getByTestId("project-save").click();
  await expect(page.getByTestId("project-savebar")).toHaveCount(0);
  await expect(apollo.getByTestId("project-lane").first().getByTestId("crew-count")).toHaveText(String(before + 1));
});

test("Project view: a day toggle is a draft edit that Discard reverts", async ({ page }) => {
  await openSchedule(page);
  const apollo = page.locator('[data-testid=project-section][data-project-id="proj-apollo"]');
  const grp = apollo.getByTestId("project-group").first();
  // capture which day is on, then re-locate by data-day (the data-on filter would re-resolve)
  const day = await grp.locator('[data-testid=project-day-toggle][data-on="true"]').first().getAttribute("data-day");
  const toggle = grp.locator(`[data-testid=project-day-toggle][data-day="${day}"]`).first();
  await toggle.click();
  await expect(toggle).toHaveAttribute("data-on", "false");
  await expect(page.getByTestId("project-savebar")).toBeVisible();
  await page.getByTestId("project-discard").click();
  await expect(toggle).toHaveAttribute("data-on", "true");
  await expect(page.getByTestId("project-savebar")).toHaveCount(0);
});

test("Project view: a seat can be assigned via its dropdown (immediate)", async ({ page }) => {
  await openSchedule(page);
  await expect(page.getByTestId("project-view")).toBeVisible();
  await page.getByTestId(`seat-select-${ALPHA_SUN_QA}`).selectOption("emp-jamie");
  await expect(page.locator(`[data-seat-id="${ALPHA_SUN_QA}"]`).first()).toHaveAttribute("data-state", "filled");
  await expect(page.getByTestId("score-badge")).not.toHaveAttribute("data-feasible", "unknown");
});

test("Project view: a project with no demand renders 'No requirements this week'", async ({ page }) => {
  await openSchedule(page);
  // add a fresh project (no demand) via the editor and save it
  await page.getByTestId("nav-editor").click();
  await page.getByTestId("add-project").click();
  const newId = await page.getByTestId("project-row").last().getAttribute("data-id");
  await page.getByTestId("editor-save").click();
  await page.getByTestId("nav-schedule").click();
  await expect(page.getByTestId("project-view")).toBeVisible();
  // the picker shows one project at a time — select the fresh one
  await page.locator(`[data-testid=project-pick][data-project-id="${newId}"]`).click();
  expect(await page.getByTestId("project-empty").count()).toBeGreaterThan(0);
  await expect(page.getByTestId("project-empty").first()).toContainText("No requirements");
});

test("Project view: decrementing a requirement to zero removes it on Save", async ({ page }) => {
  await openSchedule(page);
  const apollo = page.locator('[data-testid=project-section][data-project-id="proj-apollo"]');
  await expect(apollo.getByTestId("project-lane").first()).toBeVisible(); // wait for the build
  const before = await apollo.getByTestId("project-lane").count();
  const lane = apollo.getByTestId("project-lane").first();
  const n = parseInt((await lane.getByTestId("crew-count").textContent()) || "0", 10);
  for (let i = 0; i < n; i++) await apollo.getByTestId("project-lane").first().getByTestId("crew-dec").click();
  // count → 0 removes the role lane from the draft render immediately
  await expect(apollo.getByTestId("project-lane")).toHaveCount(before - 1);
  await page.getByTestId("project-save").click();
  await expect(page.getByTestId("project-savebar")).toHaveCount(0);
  await expect(apollo.getByTestId("project-lane")).toHaveCount(before - 1);
});

test("Project view: turning off all of a shift's days saves into a recoverable error", async ({ page }) => {
  await openSchedule(page);
  const grp = page.locator('[data-testid=project-section][data-project-id="proj-apollo"]')
    .getByTestId("project-group").first();
  for (const day of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
    const t = grp.locator(`[data-testid=project-day-toggle][data-day="${day}"]`).first();
    if ((await t.getAttribute("data-on")) === "true") await t.click();
  }
  await page.getByTestId("project-save").click();
  // the empty-days demand row is rejected by the normal validation, surfaced + recoverable
  await expect(page.getByTestId("blocked-banner")).toBeVisible();
  await expect(page.getByTestId("solve-button")).toBeDisabled();
});

test("editing requirements locks assignment in every view until Save (no clobbered edits)", async ({ page }) => {
  await openSchedule(page);
  const apollo = page.locator('[data-testid=project-section][data-project-id="proj-apollo"]');
  await expect(apollo.getByTestId("project-lane").first()).toBeVisible();
  await apollo.getByTestId("project-lane").first().getByTestId("crew-inc").click(); // make it dirty
  await expect(page.getByTestId("project-savebar")).toBeVisible();
  // Project seats are read-only while dirty (no editable SeatCell)
  expect(await page.getByTestId("project-seat-ro").count()).toBeGreaterThan(0);
  await expect(page.getByTestId("seat")).toHaveCount(0);
  // Team roster is locked
  await page.getByTestId("viewby-team").click();
  await expect(page.getByTestId("roster-locked")).toBeVisible();
  await expect(page.getByTestId("roster-assign")).toHaveCount(0);
  // Site grid is locked too: a banner shows and its seat selects are disabled
  await page.getByTestId("viewby-site").click();
  await expect(page.getByTestId("site-locked")).toBeVisible();
  await expect(page.getByTestId(`seat-select-${ALPHA_SUN_QA}`)).toBeDisabled();
  // Discard restores editability: back to Project, the seats become assignable again
  await page.getByTestId("viewby-project").click();
  await page.getByTestId("project-discard").click();
  await expect(page.getByTestId("project-savebar")).toHaveCount(0);
  await expect(page.getByTestId("project-seat-ro")).toHaveCount(0);
  expect(await page.getByTestId("seat").count()).toBeGreaterThan(0);
});

test("Employee view: 'Replace someone' reassigns an occupied seat; picker lists eligible first", async ({ page }) => {
  await openSchedule(page);
  await page.getByTestId("viewby-employee").click();
  const mayaSun = page.locator('[data-testid=roster-row][data-emp-id="emp-maya"]').getByTestId("roster-cell").first();
  const jamieSun = page.locator('[data-testid=roster-row][data-emp-id="emp-jamie"]').getByTestId("roster-cell").first();

  // assign Maya to an eligible QA seat; the picker lists eligible options before exceptional ones
  await mayaSun.getByTestId("roster-assign").click();
  const menu = mayaSun.getByTestId("roster-assign-menu");
  await expect(menu.getByTestId("roster-assign-option").first()).toHaveAttribute("data-eligible", "true");
  expect(await menu.locator('[data-testid=roster-assign-option][data-eligible="false"]').count()).toBeGreaterThan(0);
  await menu.getByTestId("roster-assign-option").first().click();
  const seatId = await mayaSun.getByTestId("roster-chip").getAttribute("data-seat-id");

  // Jamie's picker offers that occupied seat under an explicit "replace" action
  await jamieSun.getByTestId("roster-assign").click();
  const replace = jamieSun.locator(`[data-testid=roster-assign-option][data-seat-id="${seatId}"]`);
  await expect(replace).toHaveAttribute("data-replace", "true");
  await expect(replace).toContainText("replaces");
  await replace.click();

  // Jamie now holds it; Maya lost it
  await expect(jamieSun.getByTestId("roster-chip")).toHaveCount(1);
  await expect(mayaSun.getByTestId("roster-chip")).toHaveCount(0);
});
