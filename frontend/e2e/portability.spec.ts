import { test, expect, Page } from "@playwright/test";

async function openEditor(page: Page) {
  await page.goto("/");
  await page.getByTestId("nav-editor").click();
  await expect(page.getByTestId("editor")).toBeVisible();
}

// Employees live in the "Employee Preferences" tab (2026-07-02 editor layout).
async function employeeRows(page: Page) {
  await page.getByTestId("editor-tab-employees").click();
  return page.getByTestId("employee-row");
}

test("export JSON downloads a requirements file", async ({ page }) => {
  await openEditor(page);
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-json").click(),
  ]);
  expect(download.suggestedFilename()).toBe("requirements.json");
});

test("export CSV downloads a roster file (labelled lossy)", async ({ page }) => {
  await openEditor(page);
  await expect(page.getByTestId("export-csv")).toContainText("lossy roster");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-csv").click(),
  ]);
  expect(download.suggestedFilename()).toBe("roster.csv");
});

test("importing a JSON document replaces the whole roster", async ({ page }) => {
  await openEditor(page);
  await expect(await employeeRows(page)).toHaveCount(40);
  const doc = {
    sites: [{ id: "hq", name: "HQ" }],
    roles: [{ id: "dev", name: "Dev" }],
    shift_types: [{ id: "m", name: "M", start: 8, end: 16, is_night: false }],
    teams: [{ id: "a", name: "A", site: "hq" }],
    projects: [{ id: "p", name: "P", teams: ["a"] }],
    employees: [{ id: "solo", name: "Solo", team: "a", roles: ["dev"], projects: ["p"], can_manage: true }],
    demand: [{ team: "a", shift_type: "m", days: ["Sun"], crew: { p: { dev: 1 } } }],
    week_start: "2026-06-21",
  };
  await page.getByTestId("import-file").setInputFiles({
    name: "doc.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(doc)),
  });
  await expect(page.getByTestId("io-msg")).toContainText("Imported JSON");
  await expect(page.getByTestId("employee-row")).toHaveCount(1);
});

test("importing a CSV that references unknown entities is rejected and keeps the roster", async ({ page }) => {
  await openEditor(page);
  await expect(await employeeRows(page)).toHaveCount(40);
  const csv = "id,name,team,roles,projects,can_manage,status\n" +
    "x,X,Nowhere,Ghostrole,Ghostproj,false,active\n";
  await page.getByTestId("import-file").setInputFiles({
    name: "roster.csv", mimeType: "text/csv", buffer: Buffer.from(csv),
  });
  await expect(page.getByTestId("io-msg")).toContainText("failed");
  await expect(page.getByTestId("employee-row")).toHaveCount(40); // unchanged
});
