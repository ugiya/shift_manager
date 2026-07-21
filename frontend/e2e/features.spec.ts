import { test, expect, Page } from "@playwright/test";
import * as fs from "fs";

// Schedule export (print view + assignments CSV), the workload summary tab, and the
// removable carry-over seed.

async function solve(page: Page) {
  await page.goto("/");
  await page.getByTestId("solve-button").click();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true", { timeout: 40000 });
}

test("the schedule CSV lists every seat with assignment status", async ({ page }) => {
  await page.goto("/");
  // one assignment so the file shows both a filled row and UNFILLED gaps
  await page.getByTestId("viewby-team").click();
  await page.getByTestId("roster-assign").first().click();
  await page.getByTestId("roster-assign-option").first().click();
  await expect(page.getByTestId("roster-chip")).toHaveCount(1);

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByTestId("export-schedule-csv").click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^schedule-\d{4}-\d{2}-\d{2}\.csv$/);
  const content = fs.readFileSync((await download.path())!, "utf-8");
  const lines = content.trim().split("\n");
  expect(lines[0]).toBe("date,day,site,team,shift,start,end,seat,project,role,employee_id,employee,status");
  expect(lines.length).toBeGreaterThan(10);                       // one row per seat
  expect(content).toContain("UNFILLED");                          // gaps are information
  expect(content).toMatch(/,(filled|exceptional)\n/);             // the assignment we made
  expect(content).toContain("shift manager");                     // manager seats included
});

test("the print view renders the whole week for print media only", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("viewby-site")).toBeVisible();    // app loaded + built

  // hidden on screen…
  await expect(page.getByTestId("print-schedule")).toBeHidden();
  // …visible (and complete) under print media
  await page.emulateMedia({ media: "print" });
  await expect(page.getByTestId("print-schedule")).toBeVisible();
  await expect(page.locator(".print__title")).toContainText("Schedule — week of");
  expect(await page.locator(".print__team").count()).toBeGreaterThan(0);
  // while printing, the interactive app chrome is gone
  await expect(page.getByTestId("view-by")).toBeHidden();
  await page.emulateMedia({ media: "screen" });
  await expect(page.getByTestId("print-schedule")).toBeHidden();
});

test("the workload tab summarises per-employee load after a solve", async ({ page }) => {
  await solve(page);
  await page.getByTestId("sidetab-workload").click();
  const rows = page.getByTestId("workload-row");
  expect(await rows.count()).toBeGreaterThan(0);

  // a solved schedule assigns real shifts — someone works something
  const shifts = await rows.evaluateAll((els) =>
    els.map((el) => parseInt(el.getAttribute("data-shifts") ?? "0", 10)));
  expect(shifts.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);

  // heaviest-first ordering by cumulative burden
  const burdens = await rows.evaluateAll((els) =>
    els.map((el) => parseInt(el.getAttribute("data-burden") ?? "0", 10)));
  const sorted = [...burdens].sort((a, b) => b - a);
  expect(burdens).toEqual(sorted);

  // switching back restores the review (flags) panel
  await page.getByTestId("sidetab-review").click();
  await expect(page.getByTestId("flags-panel")).toBeVisible();
});

// --- Workload column sorting (PR #1) -----------------------------------------
// Deterministic without a solve: seed carry-over burdens (0/1/2/3) give the Burden
// column both ties and non-ties; two explicit night-seat assignments (Dana Tue,
// Gil Sat) do the same for Shifts / Nights / Weekends.

type Cell = { name: string; value: number };

async function readColumn(page: Page, col: number): Promise<Cell[]> {
  return page.getByTestId("workload-row").evaluateAll((rows, c) =>
    rows.map((r) => ({
      name: r.querySelector(".workload__emp")!.textContent!.trim(),
      value: Number(r.querySelectorAll("td")[c as number].textContent!.trim()),
    })), col);
}

async function readBurdens(page: Page): Promise<Cell[]> {
  return page.getByTestId("workload-row").evaluateAll((rows) =>
    rows.map((r) => ({
      name: r.querySelector(".workload__emp")!.textContent!.trim(),
      value: Number(r.getAttribute("data-burden")),
    })));
}

// vs-team sorts by the same one-decimal value the cell renders ("·" = zero delta),
// so the oracle reads the displayed text directly.
async function readVsTeam(page: Page): Promise<Cell[]> {
  return page.getByTestId("workload-row").evaluateAll((rows) =>
    rows.map((r) => {
      const txt = r.querySelectorAll("td")[5].textContent!.trim();
      return {
        name: r.querySelector(".workload__emp")!.textContent!.trim(),
        value: txt === "·" ? 0 : parseFloat(txt),
      };
    }));
}

// The UNROUNDED delta, recomputed from data-burden + the rendered team name.
// Used only to guard that the displayed-value oracle above is non-vacuous.
async function readVsTeamRaw(page: Page): Promise<Cell[]> {
  const rows = await page.getByTestId("workload-row").evaluateAll((els) =>
    els.map((r) => ({
      name: r.querySelector(".workload__emp")!.textContent!.trim(),
      team: r.querySelector(".workload__team")!.textContent!.trim(),
      burden: Number(r.getAttribute("data-burden")),
    })));
  const sums = new Map<string, { total: number; n: number }>();
  for (const r of rows) {
    const s = sums.get(r.team) ?? { total: 0, n: 0 };
    sums.set(r.team, { total: s.total + r.burden, n: s.n + 1 });
  }
  return rows.map((r) => {
    const s = sums.get(r.team)!;
    return { name: r.name, value: r.burden - s.total / s.n };
  });
}

// The panel's contract: value ascending/descending, equal values always A→Z.
function orderedNames(data: Cell[], dir: 1 | -1): string[] {
  return [...data]
    .sort((a, b) => (a.value - b.value) * dir || a.name.localeCompare(b.name))
    .map((c) => c.name);
}

const names = (data: Cell[]) => data.map((c) => c.name);

function sortHeader(page: Page, key: string) {
  return page.locator("th").filter({ has: page.getByTestId(`workload-sort-${key}`) });
}

async function openWorkload(page: Page) {
  await page.goto("/");
  await page.getByTestId("sidetab-workload").click();
  // The panel exists (empty) before the dataset arrives — wait for actual rows.
  await expect(page.getByTestId("workload-row").first()).toBeVisible();
}

// Assign the employee to a seat of the given shift type + role on the given weekday.
// (The role narrows past the shift's manager seat, whose id also contains the type.)
async function assignSeat(page: Page, empId: string, dayIdx: number, shiftType: string, role: string) {
  const cell = page.locator(`[data-testid=roster-row][data-emp-id="${empId}"]`)
    .getByTestId("roster-cell").nth(dayIdx);
  await cell.getByTestId("roster-assign").click();
  await page.locator(
    `[data-testid=roster-assign-option][data-seat-id*="${shiftType}"][data-seat-id*="${role}"]`).click();
}

test("workload defaults to burden-descending order with NO active user sort", async ({ page }) => {
  await openWorkload(page);

  // Default order, no selection: no aria-sort, no arrow anywhere.
  await expect(page.locator(".workload__table th[aria-sort]")).toHaveCount(0);
  await expect(page.locator(".workload__sort-arrow")).toHaveCount(0);

  // Burden descending with the A→Z tie-break — and the seed makes that non-vacuous.
  const burdens = await readBurdens(page);
  const distinct = new Set(burdens.map((c) => c.value)).size;
  expect(distinct).toBeGreaterThan(1);              // a real comparison exists
  expect(distinct).toBeLessThan(burdens.length);    // a tie exists
  expect(names(burdens)).toEqual(orderedNames(burdens, -1));

  // Opening Advanced keeps the order and does NOT surface Burden as a user sort.
  await page.getByTestId("workload-advanced").click();
  expect(names(await readBurdens(page))).toEqual(names(burdens));
  await expect(page.locator(".workload__table th[aria-sort]")).toHaveCount(0);
  await expect(page.locator(".workload__sort-arrow")).toHaveCount(0);
});

test("the Employee header sorts A→Z first, Z→A on the second click", async ({ page }) => {
  await openWorkload(page);
  const alphabetical = names(await readBurdens(page)).sort((a, b) => a.localeCompare(b));

  await page.getByTestId("workload-sort-name").click();
  await expect(sortHeader(page, "name")).toHaveAttribute("aria-sort", "ascending");
  await expect(page.locator(".workload__sort-arrow")).toHaveCount(1);
  await expect(page.getByTestId("workload-sort-name").locator(".workload__sort-arrow")).toBeVisible();
  expect(names(await readBurdens(page))).toEqual(alphabetical);

  await page.getByTestId("workload-sort-name").click();
  await expect(sortHeader(page, "name")).toHaveAttribute("aria-sort", "descending");
  expect(names(await readBurdens(page))).toEqual([...alphabetical].reverse());
});

test("numeric columns sort descending first, ascending second, ties A→Z both ways", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("viewby-team").click();
  await assignSeat(page, "emp-dana", 2, "st-night", "role-dev");    // Tue night → shift+night
  await assignSeat(page, "emp-gil", 6, "st-night", "role-support"); // Sat night → shift+night+weekend
  await expect(page.getByTestId("roster-chip")).toHaveCount(2);
  await page.getByTestId("sidetab-workload").click();
  await page.getByTestId("workload-advanced").click();

  // vs-team must sort by what it DISPLAYS: the seed makes Boaz (raw +1.75) and
  // Rivka (raw +1.83) both render "+1.8", and only alphabetical order puts Boaz
  // first. Guard that such a rounded-collision pair exists, otherwise the
  // displayed-value oracle below could not tell rounded from raw sorting.
  const disp = await readVsTeam(page);
  const raw = await readVsTeamRaw(page);
  expect(disp.some((d, i) => disp.some((e, j) => j !== i &&
    d.value === e.value && Math.abs(raw[i].value - raw[j].value) > 1e-9))).toBe(true);

  const columns: { key: string; read: (p: Page) => Promise<Cell[]> }[] = [
    { key: "shifts", read: (p) => readColumn(p, 1) },
    { key: "nights", read: (p) => readColumn(p, 2) },
    { key: "weekends", read: (p) => readColumn(p, 3) },
    { key: "burden", read: readBurdens },
    { key: "vsTeam", read: readVsTeam },
  ];
  for (const { key, read } of columns) {
    const data = await read(page);
    // Guards: every column has a real comparison AND a tie (see block comment above).
    const distinct = new Set(data.map((c) => c.value)).size;
    expect(distinct, key).toBeGreaterThan(1);
    expect(distinct, key).toBeLessThan(data.length);

    await page.getByTestId(`workload-sort-${key}`).click();
    await expect(sortHeader(page, key)).toHaveAttribute("aria-sort", "descending");
    await expect(page.locator(".workload__sort-arrow")).toHaveCount(1);
    await expect(page.getByTestId(`workload-sort-${key}`).locator(".workload__sort-arrow")).toHaveText("▼");
    expect(names(await read(page)), key).toEqual(orderedNames(data, -1));

    await page.getByTestId(`workload-sort-${key}`).click();
    await expect(sortHeader(page, key)).toHaveAttribute("aria-sort", "ascending");
    await expect(page.getByTestId(`workload-sort-${key}`).locator(".workload__sort-arrow")).toHaveText("▲");
    expect(names(await read(page)), key).toEqual(orderedNames(data, 1));
  }
});

test("hiding Advanced clears a Burden/vs-team sort but keeps visible-column sorts", async ({ page }) => {
  await openWorkload(page);
  const defaultOrder = names(await readBurdens(page));

  for (const key of ["burden", "vsTeam"]) {
    await page.getByTestId("workload-advanced").click();
    await page.getByTestId(`workload-sort-${key}`).click();
    await expect(sortHeader(page, key)).toHaveAttribute("aria-sort", "descending");

    await page.getByTestId("workload-advanced").click(); // hide → selection cleared
    await expect(page.locator(".workload__table th[aria-sort]")).toHaveCount(0);
    expect(names(await readBurdens(page))).toEqual(defaultOrder);
    await page.getByTestId("workload-advanced").click(); // reopen → still cleared
    await expect(page.locator(".workload__table th[aria-sort]")).toHaveCount(0);
    await expect(page.locator(".workload__sort-arrow")).toHaveCount(0);
    await page.getByTestId("workload-advanced").click(); // back to simple for next loop
  }

  // A sort on a still-visible column survives the Advanced round-trip.
  await page.getByTestId("workload-sort-shifts").click();
  await expect(sortHeader(page, "shifts")).toHaveAttribute("aria-sort", "descending");
  const shiftsOrder = names(await readBurdens(page));
  expect(shiftsOrder).not.toEqual(defaultOrder); // all-zero shifts → pure A→Z, ≠ burden order
  await page.getByTestId("workload-advanced").click();
  await page.getByTestId("workload-advanced").click();
  await expect(sortHeader(page, "shifts")).toHaveAttribute("aria-sort", "descending");
  expect(names(await readBurdens(page))).toEqual(shiftsOrder);
});

test("sort headers take keyboard focus with the shared focus ring and activate on Enter", async ({ page }) => {
  await openWorkload(page);
  await page.getByTestId("workload-advanced").focus();
  await page.keyboard.press("Tab"); // next tab stop: the Employee sort header
  const nameBtn = page.getByTestId("workload-sort-name");
  await expect(nameBtn).toBeFocused();
  const ring = await nameBtn.evaluate((el) => getComputedStyle(el).boxShadow);
  expect(ring).not.toBe("none"); // the repository-wide :focus-visible ring applies
  await page.keyboard.press("Enter");
  await expect(sortHeader(page, "name")).toHaveAttribute("aria-sort", "ascending");
});

test("the applied carry-over seed can be removed without a full reset", async ({ page }) => {
  await solve(page);
  await page.getByTestId("carry-button").click();
  await expect(page.getByTestId("seeded-tag")).toBeVisible();

  await page.getByTestId("remove-seed").click();
  await expect(page.getByTestId("seeded-tag")).toHaveCount(0);
  // the week rebuilds from the document's own carry-over fields — still usable
  await expect(page.getByTestId("solve-button")).toBeEnabled({ timeout: 15000 });
});
