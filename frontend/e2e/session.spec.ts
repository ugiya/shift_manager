import { test, expect, Page } from "@playwright/test";

// Autosave & restore: the working session (committed doc, unsaved draft, assignments,
// carry-over, UI position) persists to localStorage and survives a page reload; "Reset to
// seed" is the escape hatch. Undo/redo: assignment overrides are undoable steps.
//
// Each Playwright test gets a fresh browser context (empty localStorage), so tests here
// exercise persistence with explicit page.reload() — navigation within one test.

// The backend's fresh-start week is pinned to 2026-06-21 (SEED_WEEK_START in
// playwright.config), and the app compares a RESTORED session's week against "today"
// on load. Faking the browser clock inside the pinned week keeps these persistence
// tests dialog-free; the stale-week tests below move the clock forward on purpose.
const IN_SEED_WEEK = new Date("2026-06-24T12:00:00");   // Wed of the pinned seed week
const WEEKS_LATER = new Date("2026-07-08T09:00:00");    // Wed in the week of Sun 2026-07-05

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(IN_SEED_WEEK);
});

// Never sleep a fixed amount before reload(): the autosave debounce (300ms) RESTARTS on
// every state change, and the initial/rebuild responses keep the state churning for an
// unbounded moment — a fixed wait loses that race under load. Poll the saved session for
// the thing the test is about instead.
/* eslint-disable @typescript-eslint/no-explicit-any */
function savedSession(page: Page): Promise<any> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("shift-scheduler:session:v1");
    return raw ? JSON.parse(raw) : null;
  });
}

async function expectSavedWeek(page: Page, week: string) {
  await expect.poll(async () => (await savedSession(page))?.req?.week_start).toBe(week);
}

async function assignFirstOpenSeat(page: Page) {
  await page.getByTestId("viewby-team").click();
  await expect(page.getByTestId("roster-view")).toBeVisible();
  await page.getByTestId("roster-assign").first().click();
  await page.getByTestId("roster-assign-option").first().click();
  await expect(page.getByTestId("roster-chip")).toHaveCount(1);
}

test("an assignment override survives a page reload (restored + re-validated)", async ({ page }) => {
  await page.goto("/");
  await assignFirstOpenSeat(page);
  // the immediate re-validate settles → score reflects the assignment
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true");
  await expect.poll(async () =>
    Object.values((await savedSession(page))?.assignments ?? {}).some(Boolean)).toBe(true);

  await page.reload();
  // UI position (Team view) is restored, the assignment is back, and the score was
  // recomputed by a fresh validate — not trusted from storage.
  await expect(page.getByTestId("roster-view")).toBeVisible();
  await expect(page.getByTestId("roster-chip")).toHaveCount(1, { timeout: 15000 });
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true", { timeout: 15000 });
});

test("a saved requirements change survives a reload", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-editor").click();
  const name = page.getByTestId("name-input").first();
  await name.fill("Renamed HQ");
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-dirty")).toHaveAttribute("data-dirty", "false");
  await expect.poll(async () => (await savedSession(page))?.req?.sites?.[0]?.name).toBe("Renamed HQ");

  await page.reload();
  await expect(page.getByTestId("editor")).toBeVisible(); // editor view restored too
  await expect(page.getByTestId("name-input").first()).toHaveValue("Renamed HQ");
});

test("an UNSAVED editor draft survives a reload and is still marked dirty", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-editor").click();
  await page.getByTestId("name-input").first().fill("Draft City");
  await expect(page.getByTestId("editor-dirty")).toHaveAttribute("data-dirty", "true");
  await expect.poll(async () => (await savedSession(page))?.draft?.sites?.[0]?.name).toBe("Draft City");

  await page.reload();
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect(page.getByTestId("name-input").first()).toHaveValue("Draft City");
  await expect(page.getByTestId("editor-dirty")).toHaveAttribute("data-dirty", "true");
});

test("Reset to seed discards the session and reloads the pristine org", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-editor").click();
  const name = page.getByTestId("name-input").first();
  const original = await name.inputValue();
  await name.fill("Renamed HQ");
  await page.getByTestId("editor-save").click();
  await expect(page.getByTestId("editor-dirty")).toHaveAttribute("data-dirty", "false");

  // Two-step confirm: cancel leaves the doc alone…
  await page.getByTestId("reset-seed").click();
  await page.getByTestId("reset-seed-cancel").click();
  await expect(name).toHaveValue("Renamed HQ");

  // …confirming resets to the server seed.
  await page.getByTestId("reset-seed").click();
  await page.getByTestId("reset-seed-confirm").click();
  await expect(page.getByTestId("name-input").first()).toHaveValue(original);
  await expect(page.getByTestId("editor-dirty")).toHaveAttribute("data-dirty", "false");
});

test("undo and redo step through assignment overrides", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("viewby-team").click();
  await expect(page.getByTestId("roster-view")).toBeVisible();
  await expect(page.getByTestId("undo-button")).toBeDisabled();
  await expect(page.getByTestId("redo-button")).toBeDisabled();

  await page.getByTestId("roster-assign").first().click();
  await page.getByTestId("roster-assign-option").first().click();
  await expect(page.getByTestId("roster-chip")).toHaveCount(1);

  await page.getByTestId("undo-button").click();
  await expect(page.getByTestId("roster-chip")).toHaveCount(0);
  await expect(page.getByTestId("redo-button")).toBeEnabled();

  await page.getByTestId("redo-button").click();
  await expect(page.getByTestId("roster-chip")).toHaveCount(1);
  await expect(page.getByTestId("redo-button")).toBeDisabled();
});

test("keyboard undo/redo (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z) works outside form fields", async ({ page }) => {
  await page.goto("/");
  await assignFirstOpenSeat(page);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.getByTestId("roster-chip")).toHaveCount(0);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(page.getByTestId("roster-chip")).toHaveCount(1);
});

test("a solve re-baselines history — undo is disabled after it", async ({ page }) => {
  await page.goto("/");
  await assignFirstOpenSeat(page);
  await expect(page.getByTestId("undo-button")).toBeEnabled();

  await page.getByTestId("solve-button").click();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true", { timeout: 40000 });
  await expect(page.getByTestId("undo-button")).toBeDisabled();
  await expect(page.getByTestId("redo-button")).toBeDisabled();
});

// --- stale-week ask-on-load + week picker -------------------------------------------

test("a fresh start (no saved session) never asks — it just gets the server's week", async ({ page }) => {
  // Even with "today" weeks past the seed week, a fresh start takes the server's word
  // for the week (the server hands out the current week; pinned here for determinism).
  await page.clock.setFixedTime(WEEKS_LATER);
  await page.goto("/");
  await expect(page.getByTestId("week-picker")).toHaveValue("2026-06-21");
  await expect(page.getByTestId("stale-week-dialog")).toHaveCount(0);
});

test("a restored stale-week session asks on load — Stay keeps the saved week", async ({ page }) => {
  await page.goto("/");                       // seed week, autosaves a session
  await expect(page.getByTestId("week-picker")).toHaveValue("2026-06-21");
  await expectSavedWeek(page, "2026-06-21");

  await page.clock.setFixedTime(WEEKS_LATER); // ...days pass...
  await page.reload();
  await expect(page.getByTestId("stale-week-dialog")).toBeVisible();
  await page.getByTestId("stale-week-stay").click();
  await expect(page.getByTestId("stale-week-dialog")).toHaveCount(0);
  await expect(page.getByTestId("week-picker")).toHaveValue("2026-06-21");
});

test("a restored stale-week session asks on load — Jump starts the current week", async ({ page }) => {
  await page.goto("/");
  await expectSavedWeek(page, "2026-06-21");

  await page.clock.setFixedTime(WEEKS_LATER);
  await page.reload();
  await expect(page.getByTestId("stale-week-dialog")).toBeVisible();
  await page.getByTestId("stale-week-jump").click();
  await expect(page.getByTestId("stale-week-dialog")).toHaveCount(0);

  // The week jumped to the Sunday of "today's" week; the schedule reset with it.
  await expect(page.getByTestId("week-picker")).toHaveValue("2026-07-05");
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "unknown");

  // The choice sticks: once the jump is autosaved, a reload in the same week asks nothing.
  await expectSavedWeek(page, "2026-07-05");
  await page.reload();
  await expect(page.getByTestId("stale-week-dialog")).toHaveCount(0);
  await expect(page.getByTestId("week-picker")).toHaveValue("2026-07-05");
});

test("Jump is gated while the restored session carries an unsaved draft", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("nav-editor").click();
  await page.getByTestId("name-input").first().fill("Draft City");   // unsaved draft
  await expect.poll(async () => (await savedSession(page))?.draft?.sites?.[0]?.name).toBe("Draft City");

  await page.clock.setFixedTime(WEEKS_LATER);
  await page.reload();
  await expect(page.getByTestId("stale-week-dialog")).toBeVisible();
  // Jumping would commit a new doc and the draft-resync rule would discard the unsaved
  // edits — so it's disabled (same rule as the week picker); Stay works normally.
  await expect(page.getByTestId("stale-week-jump")).toBeDisabled();
  await page.getByTestId("stale-week-stay").click();
  await expect(page.getByTestId("editor")).toBeVisible();
  await expect(page.getByTestId("name-input").first()).toHaveValue("Draft City");
  await expect(page.getByTestId("editor-dirty")).toHaveAttribute("data-dirty", "true");
});

test("the week picker schedules any week — snapping to Sunday — and carry works from it", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("week-picker")).toHaveValue("2026-06-21");

  // Pick a WEDNESDAY: the week snaps to its Sunday and the grid re-dates.
  await page.getByTestId("week-picker").fill("2026-07-08");
  await expect(page.getByTestId("week-picker")).toHaveValue("2026-07-05");
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "unknown");
  await page.getByTestId("viewby-site").click();
  await expect(page.locator('[data-seat-id*="2026-07-05"]').first()).toBeVisible();

  // The new week solves and carries forward exactly like the seed week.
  await page.getByTestId("solve-button").click();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true", { timeout: 40000 });
  await page.getByTestId("carry-button").click();
  await expect(page.getByTestId("week-picker")).toHaveValue("2026-07-12");
  await expect(page.getByTestId("seeded-tag")).toBeVisible();
});
