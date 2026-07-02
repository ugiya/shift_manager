// The suite depends on the backend serving the PINNED fresh-start week (SEED_WEEK_START
// in playwright.config's webServer command) — seat ids in the specs embed its dates.
// With `reuseExistingServer: true`, an already-running (old / unpinned) uvicorn on :8000
// silently takes the webServer's place and causes phantom date failures. Fail fast with
// the actual problem instead. (Runs whether the server was reused or freshly started.)
const PINNED = "2026-06-21";

export default async function globalSetup() {
  let week: string | undefined;
  try {
    const r = await fetch("http://127.0.0.1:8000/api/requirements");
    week = (await r.json()).week_start;
  } catch {
    return; // nothing on :8000 yet — Playwright will start its own pinned server
  }
  if (week !== PINNED) {
    throw new Error(
      `The backend on :8000 serves week_start=${week}, not the pinned ${PINNED} — ` +
      `a stale (old or unpinned) uvicorn is being reused. Kill it first: ` +
      `lsof -ti tcp:8000 | xargs kill`,
    );
  }
}
