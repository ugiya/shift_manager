import { test, expect, Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "mobile-portrait", width: 375, height: 667 },
  { name: "mobile-large", width: 414, height: 896 },
  { name: "tablet-portrait", width: 768, height: 1024 },
  { name: "tablet-landscape", width: 1024, height: 768 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "desktop", width: 1920, height: 1080 },
];

/**
 * Returns elements whose rendered box spills OUTSIDE the viewport horizontally,
 * EXCEPT content that legitimately lives inside a horizontal scroll container
 * (the schedule grid). Anything returned is a real overflow bug.
 */
function overflowOffenders() {
  const vw = window.innerWidth;
  const offenders: { tag: string; cls: string; right: number; left: number }[] = [];
  document.querySelectorAll<HTMLElement>("body *").forEach((el) => {
    // ignore anything inside an element that is allowed to scroll horizontally
    let p: HTMLElement | null = el.parentElement;
    while (p) {
      const ox = getComputedStyle(p).overflowX;
      if (ox === "auto" || ox === "scroll") return;
      p = p.parentElement;
    }
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.right > vw + 1 || r.left < -1) {
      offenders.push({ tag: el.tagName, cls: el.className, right: Math.round(r.right), left: Math.round(r.left) });
    }
  });
  return offenders;
}

function pageHorizontalScroll() {
  const de = document.documentElement;
  return de.scrollWidth - de.clientWidth;
}

async function assertNoOverflow(page: Page, label: string) {
  const offenders = await page.evaluate(overflowOffenders);
  expect(offenders, `${label}: elements overflow the viewport: ${JSON.stringify(offenders)}`).toEqual([]);
  const scroll = await page.evaluate(pageHorizontalScroll);
  expect(scroll, `${label}: page scrolls horizontally by ${scroll}px`).toBeLessThanOrEqual(1);
}

test("no element overflows its bounds at any viewport (pre-solve)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("presolve-hint")).toBeVisible();
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(150);
    await assertNoOverflow(page, `pre-solve ${vp.name} (${vp.width})`);
  }
});

test("no element overflows its bounds at any viewport (post-solve, fully populated)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByTestId("solve-button").click();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true");
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.waitForTimeout(150);
    await assertNoOverflow(page, `post-solve ${vp.name} (${vp.width})`);
  }
});

test("the wide schedule grid is reachable via horizontal scroll on mobile (not clipped)", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");
  // the grid lives in a horizontal scroller, so its content is wider than the cell box
  const scrollable = await page.locator(".grid-scroll").first().evaluate((el) => el.scrollWidth > el.clientWidth + 1);
  expect(scrollable, "schedule grid should scroll horizontally rather than clip on mobile").toBe(true);
});

test("text inside seats and flags stays within its box (no spill) after solving", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");
  await page.getByTestId("solve-button").click();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true");
  // wrapping text containers must not have content taller-clipped or wider than their box
  const spill = await page.evaluate(() => {
    const sel = [".seat__labeltext", ".flag__title", ".flag__detail", ".team__title", ".hint"];
    const bad: { cls: string; sw: number; cw: number }[] = [];
    for (const s of sel) {
      document.querySelectorAll<HTMLElement>(s).forEach((el) => {
        // these all wrap, so scrollWidth must not exceed clientWidth
        if (el.scrollWidth > el.clientWidth + 1) {
          bad.push({ cls: s, sw: el.scrollWidth, cw: el.clientWidth });
        }
      });
    }
    return bad;
  });
  expect(spill, `text spills outside its box: ${JSON.stringify(spill)}`).toEqual([]);
});
