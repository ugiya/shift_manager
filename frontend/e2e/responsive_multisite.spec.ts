import { test, expect, Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "mobile", width: 375, height: 667 },
  { name: "mobile-l", width: 414, height: 896 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "tablet-l", width: 1024, height: 768 },
  { name: "laptop", width: 1280, height: 800 },
  { name: "desktop", width: 1920, height: 1080 },
];

const SITES = ["site-ta", "site-hf", "site-jm", "site-bs"];

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

async function assertClean(page: Page, label: string) {
  const offenders = await page.evaluate(overflowOffenders);
  expect(offenders, `${label}: overflow -> ${JSON.stringify(offenders)}`).toEqual([]);
  const scroll = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(scroll, `${label}: page h-scroll ${scroll}px`).toBeLessThanOrEqual(1);
}

// pre-solve: one test per (viewport x site) — fast, no solving
for (const vp of VIEWPORTS) {
  for (const site of SITES) {
    test(`no overflow at ${vp.name} on ${site} (pre-solve)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto("/");
      await page.locator(`[data-testid=site-tab][data-site-id="${site}"]`).click();
      await assertClean(page, `${vp.name}/${site}`);
    });
  }
}

// post-solve: solve once, then sweep every viewport x site fully populated
test("no overflow at any viewport on any site (post-solve)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.getByTestId("solve-button").click();
  await expect(page.getByTestId("score-badge")).toHaveAttribute("data-feasible", "true");
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const site of SITES) {
      await page.locator(`[data-testid=site-tab][data-site-id="${site}"]`).click();
      await page.waitForTimeout(80);
      await assertClean(page, `post-solve ${vp.name}/${site}`);
    }
  }
});

test("the site tab bar itself never overflows the page (mobile)", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");
  // the bar may scroll internally, but must not widen the page
  const scroll = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(scroll).toBeLessThanOrEqual(1);
});
