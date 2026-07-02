import type { Lang } from "./i18n";

// Week arithmetic + date display, shared by the topbar (range/picker), the stale-week
// dialog and the print view. The scheduling week starts on SUNDAY — the same convention
// as the backend seed (data.WEEK_START) and the Fri/Sat weekend config — and both the
// stale-session check and the picker snap through weekStartOf so they can't disagree.
// All computations are local wall-clock (the backend's local-naive datetime contract):
// never toISOString(), which would shift the date across the UTC boundary.

/** Local Date for an ISO date string (midnight local, not UTC). */
export function localDate(iso: string): Date {
  return new Date(iso + "T00:00:00");
}

function isoOf(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The ISO date of the Sunday on or before `d` — the week that contains it. */
export function weekStartOf(d: Date): string {
  return isoOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()));
}

/** The week to schedule when nothing says otherwise: today's week. */
export function currentWeekStart(): string {
  return weekStartOf(new Date());
}

const locale = (lang?: Lang) => (lang === "he" ? "he-IL" : undefined);

// The formatters never throw on a malformed date string (Intl raises RangeError on an
// Invalid Date): a corrupt week_start from an imported/hand-edited doc must surface as
// backend validation errors, not crash the topbar render outside any error boundary.
const invalid = (d: Date) => isNaN(d.getTime());

/** Short day-month, e.g. "Jun 21" — for tight chrome like the Carry button. */
export function fmtDay(iso: string, lang?: Lang): string {
  const d = localDate(iso);
  if (invalid(d)) return iso;
  return d.toLocaleDateString(locale(lang), { month: "short", day: "numeric" });
}

/** The 7-day week range with year, e.g. "Jun 21 – 27, 2026". Wrap in <bdi> when
 *  embedding in RTL text — a bare LTR range inside Hebrew bidi-scrambles. */
export function fmtWeekRange(weekStartIso: string, lang?: Lang): string {
  const start = localDate(weekStartIso);
  if (invalid(start)) return weekStartIso;
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6);
  return new Intl.DateTimeFormat(locale(lang), {
    day: "numeric", month: "short", year: "numeric",
  }).formatRange(start, end);
}

/** Full date for tooltips, e.g. "Sunday, June 21, 2026". */
export function fmtFull(iso: string, lang?: Lang): string {
  const d = localDate(iso);
  if (invalid(d)) return iso;
  return d.toLocaleDateString(locale(lang), {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
}
