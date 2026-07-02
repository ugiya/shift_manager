import { test, expect } from "@playwright/test";

// UI-chrome i18n: the topbar language toggle flips the whole app between English (LTR,
// the default) and Hebrew (RTL). The choice persists in localStorage across reloads,
// independently of the autosaved session.

test("the language toggle switches to Hebrew and RTL, and persists", async ({ page }) => {
  // Keep "today" inside the pinned seed week: the reload below restores an autosaved
  // session, and a stale week would otherwise pop the ask-on-load dialog over the UI.
  await page.clock.setFixedTime(new Date("2026-06-24T12:00:00"));
  await page.goto("/");
  await page.getByTestId("lang-toggle").click();

  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  await expect(page.locator(".topbar h1")).toContainText("מנהל משמרות");
  await expect(page.getByTestId("viewby-project")).toHaveText("פרויקט");

  // Persistence: the preference is written to localStorage; survive a reload.
  await page.waitForTimeout(500);
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

  // Toggle back to English.
  await page.getByTestId("lang-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await expect(page.locator(".topbar h1")).toHaveText("Shift Scheduler");
});

test("English remains the default", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".topbar h1")).toHaveText("Shift Scheduler");
  const dir = await page.locator("html").getAttribute("dir");
  expect(dir === null || dir === "" || dir === "ltr").toBeTruthy();
});
