import { test, expect, Page } from "@playwright/test";

async function openEditor(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("nav-editor")).toBeVisible();
  await page.getByTestId("nav-editor").click();
  await expect(page.getByTestId("editor")).toBeVisible();
}

async function openTab(page: Page, tab: "org" | "employees" | "demand") {
  await page.getByTestId(`editor-tab-${tab}`).click();
}

function overflowOffenders() {
  const vw = window.innerWidth;
  const bad: string[] = [];
  document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
    let p: HTMLElement | null = el.parentElement;
    while (p) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll") return;
      p = p.parentElement;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.right > vw + 1 || r.left < -1) bad.push(el.className || el.tagName);
  });
  return bad;
}

// --- 2026-07-02 layout: Organization | Employee Preferences | Project Requirements ----

test("the editor is tabbed; each tab shows its sections", async ({ page }) => {
  await openEditor(page);
  // Organization (default tab): org structure only.
  await expect(page.locator(".esec__head h3")).toHaveText(["Sites", "Roles", "Shift types", "Teams", "Projects"]);
  await expect(page.getByTestId("site-row")).toHaveCount(4);

  await openTab(page, "employees");
  await expect(page.locator(".esec__head h3")).toHaveText(["Employees"]);
  await expect(page.getByTestId("employee-row")).toHaveCount(40);

  await openTab(page, "demand");
  await expect(page.locator(".esec__head h3")).toHaveText(["Working this week", "Demand"]);
  await expect(page.getByTestId("demand-row")).toHaveCount(12);
});

test("the employee list filters by team", async ({ page }) => {
  await openEditor(page);
  await openTab(page, "employees");
  await expect(page.getByTestId("employee-row")).toHaveCount(40);

  await page.getByTestId("employee-team-filter").selectOption("team-alpha");
  const rows = page.getByTestId("employee-row");
  await expect(rows).toHaveCount(8);
  for (const sel of await page.getByTestId("employee-team").all()) {
    await expect(sel).toHaveValue("team-alpha");
  }

  await page.getByTestId("employee-team-filter").selectOption("");
  await expect(page.getByTestId("employee-row")).toHaveCount(40);
});

test("Project Requirements filters demand rows and crew to one project", async ({ page }) => {
  await openEditor(page);
  await openTab(page, "demand");
  await expect(page.getByTestId("demand-row")).toHaveCount(12);

  await page.getByTestId("project-filter").selectOption("proj-apollo");
  const n = await page.getByTestId("demand-row").count();
  expect(n).toBeGreaterThan(0);
  expect(n).toBeLessThan(12);
  // Within the visible rows, only Apollo's crew chunk is shown (the project lead's view).
  expect(await page.locator('[data-testid^="crew-"]').count()).toBeGreaterThan(0);
  expect(await page
    .locator('[data-testid^="crew-"]:not([data-testid^="crew-proj-apollo-"])').count()).toBe(0);

  await page.getByTestId("project-filter").selectOption("");
  await expect(page.getByTestId("demand-row")).toHaveCount(12);
});

// --- null-out deletes: delete is always enabled; references become "Please choose" ----

test("adding a site appends a row; deleting it removes it again", async ({ page }) => {
  await openEditor(page);
  await expect(page.getByTestId("site-row")).toHaveCount(4);
  await page.getByTestId("add-site").click();
  await expect(page.getByTestId("site-row")).toHaveCount(5);
  await page.getByTestId("site-row").last().getByTestId("delete-site").click();
  await expect(page.getByTestId("site-row")).toHaveCount(4);
});

test("deleting a referenced site leaves its teams on 'Please choose' until re-picked", async ({ page }) => {
  await openEditor(page);
  await page.locator('[data-testid=site-row][data-id="site-ta"]').getByTestId("delete-site").click();
  await expect(page.getByTestId("site-row")).toHaveCount(3);

  // Its teams now carry a pending site reference…
  const pending = page.locator("select[data-testid=team-site].in--pending");
  expect(await pending.count()).toBeGreaterThan(0);
  // …which blocks the Save with an actionable error (not a spooky unknown-ref one).
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-errors")).toContainText("has no site — choose one");

  // Re-picking a site (the placeholder is disabled, index 1 = first real site) heals it.
  while (await pending.count()) await pending.first().selectOption({ index: 1 });
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-errors")).toHaveCount(0);
});

test("deleting a referenced role strips it from employees and demand crews cleanly", async ({ page }) => {
  await openEditor(page);
  await page.locator('[data-testid=role-row][data-id="role-dev"]').getByTestId("delete-role").click();
  await expect(page.locator('[data-testid=role-row][data-id="role-dev"]')).toHaveCount(0);
  // Nothing dangles: the role vanished from employee chips and crew counts, so Save is clean.
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-errors")).toHaveCount(0);
  await openTab(page, "employees");
  await expect(page.locator('[data-testid=chips-roles] [data-chip="role-dev"]')).toHaveCount(0);
});

test("deleting a shift type un-prefers it and leaves its demand on 'Please choose'", async ({ page }) => {
  await openEditor(page);
  await page.locator('[data-testid=shifttype-row][data-id="st-morning"]').getByTestId("delete-shifttype").click();
  await expect(page.locator('[data-testid=shifttype-row][data-id="st-morning"]')).toHaveCount(0);

  await openTab(page, "demand");
  expect(await page.locator("select[data-testid=demand-shifttype].in--pending").count()).toBeGreaterThan(0);
  await page.getByTestId("editor-save").click();
  const errors = page.getByTestId("editor-errors");
  await expect(errors).toContainText("has no shift type — choose one");
  // The preference lists were pruned with it — no stale-preference error appears.
  await expect(errors).not.toContainText("prefers unknown shift type");
});

test("deleting a team leaves its employees and demand on 'Please choose'", async ({ page }) => {
  await openEditor(page);
  await page.locator('[data-testid=team-row][data-id="team-alpha"]').getByTestId("delete-team").click();
  await expect(page.locator('[data-testid=team-row][data-id="team-alpha"]')).toHaveCount(0);

  await openTab(page, "employees");
  expect(await page.locator("select[data-testid=employee-team].in--pending").count()).toBe(8);
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-errors")).toContainText("has no team — choose one");
});

// --- per-week project tick (Project Requirements) --------------------------------------

test("unticking a project pauses it for the week: no seats, hidden from employee prefs", async ({ page }) => {
  await openEditor(page);
  await openTab(page, "demand");
  await page.locator('[data-testid=project-thisweek][data-project-id="proj-apollo"]').uncheck();
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-errors")).toHaveCount(0);

  // Hidden as a project in the employees section (membership itself is kept).
  await openTab(page, "employees");
  await expect(page.locator('[data-testid=chips-projects] [data-chip="proj-apollo"]')).toHaveCount(0);

  // No Apollo seats materialise this week; the rest of the org still runs.
  await page.getByTestId("nav-schedule").click();
  await page.getByTestId("viewby-site").click();
  await expect(page.locator('[data-seat-id*="proj-apollo"]')).toHaveCount(0);
  await expect(page.locator("[data-seat-id]").first()).toBeVisible();

  // Re-ticking brings the seats back.
  await page.getByTestId("nav-editor").click();
  await openTab(page, "demand");
  await page.locator('[data-testid=project-thisweek][data-project-id="proj-apollo"]').check();
  await page.getByTestId("editor-save").click();
  await page.getByTestId("nav-schedule").click();
  await expect(page.locator('[data-seat-id*="proj-apollo"]').first()).toBeVisible();
});

// --- employees tab ---------------------------------------------------------------------

test("add and remove an employee", async ({ page }) => {
  await openEditor(page);
  await openTab(page, "employees");
  await page.getByTestId("add-employee").click();
  await expect(page.getByTestId("employee-row")).toHaveCount(41);
  const row = page.getByTestId("employee-row").last();
  await row.getByTestId("name-input").fill("Test Person");
  await expect(row.getByTestId("name-input")).toHaveValue("Test Person");
  await row.getByTestId("delete-employee").click();
  await expect(page.getByTestId("employee-row")).toHaveCount(40);
});

test("toggling a role chip on an employee persists", async ({ page }) => {
  await openEditor(page);
  await openTab(page, "employees");
  await page.getByTestId("add-employee").click();
  const row = page.getByTestId("employee-row").last();
  const chip = row.getByTestId("chips-roles").locator('[data-chip="role-dev"]');
  await expect(chip).not.toHaveClass(/is-on/);
  await chip.click();
  await expect(chip).toHaveClass(/is-on/);
});

test("an employee's unavailable dates can be added and removed (Phase 3)", async ({ page }) => {
  await openEditor(page);
  await openTab(page, "employees");
  await page.getByTestId("add-employee").click();
  const control = page.getByTestId("employee-row").last().getByTestId("employee-unavailable");
  await expect(control.getByTestId("unavail-date")).toHaveCount(0);
  await control.getByTestId("unavail-add").fill("2026-06-22");
  const chip = control.getByTestId("unavail-date");
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveAttribute("data-date", "2026-06-22");
  await chip.click(); // clicking the chip removes the date
  await expect(control.getByTestId("unavail-date")).toHaveCount(0);
});

test("an employee's preferred shift types can be toggled (Phase 4)", async ({ page }) => {
  await openEditor(page);
  await openTab(page, "employees");
  await page.getByTestId("add-employee").click();
  const chips = page.getByTestId("employee-row").last().getByTestId("chips-prefers");
  await expect(chips).toBeVisible();
  const firstChip = chips.locator(".chip").first();
  await expect(firstChip).not.toHaveClass(/is-on/);
  await firstChip.click();
  await expect(firstChip).toHaveClass(/is-on/);
});

// --- demand tab --------------------------------------------------------------------------

test("a demand row with no days blocks solving, and fixing it re-enables", async ({ page }) => {
  await openEditor(page);
  await openTab(page, "demand");
  await page.getByTestId("add-demand").click();
  const row = page.getByTestId("demand-row").last();
  // new row defaults to Sunday; turn it off -> no days. Edits are LOCAL until Save (Round 2 #1).
  await row.locator('[data-testid=day-toggle][data-day="Sun"]').click();
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-errors")).toBeVisible();
  await expect(page.getByTestId("editor-errors")).toContainText("no days");
  await expect(page.getByTestId("solve-button")).toBeDisabled();
  // turn Sunday back on -> Save -> error clears -> solve enabled
  await row.locator('[data-testid=day-toggle][data-day="Sun"]').click();
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-errors")).toHaveCount(0);
  await expect(page.getByTestId("solve-button")).toBeEnabled();
});

test("the blocked banner shows in the schedule view while there are errors", async ({ page }) => {
  await openEditor(page);
  await openTab(page, "demand");
  await page.getByTestId("add-demand").click();
  await page.getByTestId("demand-row").last().locator('[data-testid=day-toggle][data-day="Sun"]').click();
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-errors")).toBeVisible();
  await page.getByTestId("nav-schedule").click();
  await expect(page.getByTestId("blocked-banner")).toBeVisible();
});

test("editing the org then solving still produces a full, feasible schedule", async ({ page }) => {
  await openEditor(page);
  await openTab(page, "employees");
  // add a developer to Team Alpha on Apollo (valid, additive)
  await page.getByTestId("add-employee").click();
  const row = page.getByTestId("employee-row").last();
  await row.getByTestId("name-input").fill("Extra Dev");
  await row.getByTestId("chips-roles").locator('[data-chip="role-dev"]').click();
  await row.getByTestId("chips-projects").locator('[data-chip="proj-apollo"]').click();
  // commit the draft before solving (Round 2 #1: Solve is gated while there are unsaved edits)
  await page.getByTestId("editor-save").click();
  await page.getByTestId("solve-button").click();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true");
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-filled", "135");
});

// --- Round 2 #1: draft + Save / Discard editor -----------------------------------------

test("editor edits stay local until Save; Save commits, and the topbar reflects only saved state", async ({ page }) => {
  await openEditor(page);
  await expect(page.getByTestId("site-row")).toHaveCount(4);
  await expect(page.locator(".topbar__site")).toContainText("4 sites");
  // Save/Discard are disabled with a clean draft.
  await expect(page.getByTestId("editor-save")).toBeDisabled();
  await expect(page.getByTestId("editor-discard")).toBeDisabled();

  // Add a site: the editor (draft) updates immediately, but the committed doc does NOT.
  await page.getByTestId("add-site").click();
  await expect(page.getByTestId("site-row")).toHaveCount(5);
  await expect(page.locator(".topbar__site")).toContainText("4 sites"); // still committed=4
  await expect(page.getByTestId("editor-dirty")).toHaveAttribute("data-dirty", "true");
  await expect(page.getByTestId("nav-editor-dirty")).toBeVisible();
  await expect(page.getByTestId("solve-button")).toBeDisabled(); // gated while unsaved

  // Save commits the draft -> topbar reflects it, dirty clears, Solve re-enables.
  await page.getByTestId("editor-save").click();
  await expect(page.locator(".topbar__site")).toContainText("5 sites");
  await expect(page.getByTestId("editor-dirty")).toHaveAttribute("data-dirty", "false");
  await expect(page.getByTestId("nav-editor-dirty")).toHaveCount(0);
  await expect(page.getByTestId("solve-button")).toBeEnabled();
});

test("Discard reverts the draft to the last saved version", async ({ page }) => {
  await openEditor(page);
  await expect(page.getByTestId("site-row")).toHaveCount(4);
  await page.getByTestId("add-site").click();
  await page.getByTestId("add-site").click();
  await expect(page.getByTestId("site-row")).toHaveCount(6);
  await expect(page.getByTestId("editor-discard")).toBeEnabled();
  await page.getByTestId("editor-discard").click();
  await expect(page.getByTestId("site-row")).toHaveCount(4);
  await expect(page.getByTestId("editor-dirty")).toHaveAttribute("data-dirty", "false");
  await expect(page.locator(".topbar__site")).toContainText("4 sites");
});

test("saving an edit invalidates the prior solved score at once (no stale-feasible window)", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("solve-button").click();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true", { timeout: 40000 });
  // Edit the org into an invalid state and Save.
  await page.getByTestId("nav-editor").click();
  await openTab(page, "demand");
  await page.getByTestId("add-demand").click();
  await page.getByTestId("demand-row").last().locator('[data-testid=day-toggle][data-day="Sun"]').click();
  await page.getByTestId("editor-save").click();
  // The prior feasible score is cleared synchronously; Solve stays disabled (rebuild → errors).
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "unknown");
  await expect(page.getByTestId("editor-errors")).toBeVisible();
  await expect(page.getByTestId("solve-button")).toBeDisabled();
});

test("unsaved edits survive switching to the schedule view and back", async ({ page }) => {
  await openEditor(page);
  await page.getByTestId("add-site").click();
  await expect(page.getByTestId("site-row")).toHaveCount(5);
  // The draft lives in App, so leaving and re-entering the editor keeps the unsaved edit.
  await page.getByTestId("nav-schedule").click();
  await expect(page.getByTestId("view-by")).toBeVisible();
  await page.getByTestId("nav-editor").click();
  await expect(page.getByTestId("site-row")).toHaveCount(5);
  await expect(page.getByTestId("editor-dirty")).toHaveAttribute("data-dirty", "true");
});

test("the editor does not overflow on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await openEditor(page);
  const offenders = await page.evaluate(overflowOffenders);
  expect(offenders, `overflow: ${JSON.stringify(offenders)}`).toEqual([]);
  const scroll = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(scroll).toBeLessThanOrEqual(1);
});
