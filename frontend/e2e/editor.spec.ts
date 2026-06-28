import { test, expect, Page } from "@playwright/test";

async function openEditor(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("nav-editor")).toBeVisible();
  await page.getByTestId("nav-editor").click();
  await expect(page.getByTestId("editor")).toBeVisible();
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

test("editor shows every section with the seed data", async ({ page }) => {
  await openEditor(page);
  const titles = await page.locator(".esec__head h3").allTextContents();
  expect(titles).toEqual(["Sites", "Roles", "Shift types", "Teams", "Projects", "Employees", "Demand"]);
  await expect(page.getByTestId("employee-row")).toHaveCount(40);
  await expect(page.getByTestId("demand-row")).toHaveCount(12);
  await expect(page.getByTestId("site-row")).toHaveCount(4);
});

test("adding a site appends a row; the new one is deletable", async ({ page }) => {
  await openEditor(page);
  await expect(page.getByTestId("site-row")).toHaveCount(4);
  await page.getByTestId("add-site").click();
  await expect(page.getByTestId("site-row")).toHaveCount(5);
  // the new (last) site is unreferenced -> its delete is enabled
  const lastDelete = page.getByTestId("site-row").last().getByTestId("delete-site");
  await expect(lastDelete).toBeEnabled();
  await lastDelete.click();
  await expect(page.getByTestId("site-row")).toHaveCount(4);
});

test("a referenced site cannot be deleted", async ({ page }) => {
  await openEditor(page);
  // Tel Aviv HQ has teams -> delete disabled
  const ta = page.locator('[data-testid=site-row][data-id="site-ta"]');
  await expect(ta.getByTestId("delete-site")).toBeDisabled();
});

test("a referenced role cannot be deleted but an unused new one can", async ({ page }) => {
  await openEditor(page);
  // Developer is used -> disabled
  const devRow = page.locator('[data-testid=role-row][data-id="role-dev"]');
  await expect(devRow.getByTestId("delete-role")).toBeDisabled();
  // a fresh role is unused -> deletable
  await page.getByTestId("add-role").click();
  await expect(page.getByTestId("role-row").last().getByTestId("delete-role")).toBeEnabled();
});

test("add and remove an employee", async ({ page }) => {
  await openEditor(page);
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
  await page.getByTestId("add-employee").click();
  const row = page.getByTestId("employee-row").last();
  const chip = row.getByTestId("chips-roles").locator('[data-chip="role-dev"]');
  await expect(chip).not.toHaveClass(/is-on/);
  await chip.click();
  await expect(chip).toHaveClass(/is-on/);
});

test("an employee's unavailable dates can be added and removed (Phase 3)", async ({ page }) => {
  await openEditor(page);
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
  await page.getByTestId("add-employee").click();
  const chips = page.getByTestId("employee-row").last().getByTestId("chips-prefers");
  await expect(chips).toBeVisible();
  const firstChip = chips.locator(".chip").first();
  await expect(firstChip).not.toHaveClass(/is-on/);
  await firstChip.click();
  await expect(firstChip).toHaveClass(/is-on/);
});

test("a shift type preferred by an employee cannot be deleted (Phase 4 referential integrity)", async ({ page }) => {
  await openEditor(page);
  // a fresh shift type is unused by demand -> deletable
  await page.getByTestId("add-shifttype").click();
  const stRow = page.getByTestId("shifttype-row").last();
  const stId = await stRow.getAttribute("data-id");
  await expect(stRow.getByTestId("delete-shifttype")).toBeEnabled();
  // an employee prefers it -> now referenced -> delete blocked (backend would reject a stale id)
  await page.getByTestId("add-employee").click();
  await page.getByTestId("employee-row").last().getByTestId("chips-prefers")
    .locator(`[data-chip="${stId}"]`).click();
  await expect(stRow.getByTestId("delete-shifttype")).toBeDisabled();
});

test("a demand row with no days blocks solving, and fixing it re-enables", async ({ page }) => {
  await openEditor(page);
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
  await page.getByTestId("add-demand").click();
  await page.getByTestId("demand-row").last().locator('[data-testid=day-toggle][data-day="Sun"]').click();
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-errors")).toBeVisible();
  await page.getByTestId("nav-schedule").click();
  await expect(page.getByTestId("blocked-banner")).toBeVisible();
});

test("editing the org then solving still produces a full, feasible schedule", async ({ page }) => {
  await openEditor(page);
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
