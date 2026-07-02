import type { Assignments, CarryoverSeed, RequirementsDoc } from "../types";

// Autosave: the whole working session — the committed requirements doc, any unsaved
// draft, the current assignments and the applied carry-over seed — persists to
// localStorage so a page refresh (or crash) loses nothing. The client is the system
// of record for the requirements document (there is no server-side store), which is
// why losing it on refresh was a real data-loss bug, not a convenience gap.

const KEY = "shift-scheduler:session:v1";

export interface SavedUi {
  view: "schedule" | "editor";
  scheduleView: "site" | "team" | "project" | "employee";
  siteId: string;
  /** Project-view picker: a project id, "*" for all, "" = default (first project). */
  projectId: string;
}

export interface SavedSession {
  v: 1;
  req: RequirementsDoc;
  /** The unsaved editor draft, or null when the draft matched the committed doc. */
  draft: RequirementsDoc | null;
  assignments: Assignments;
  carryover: CarryoverSeed | null;
  ui: SavedUi;
  savedAt: string;
}

const DOC_COLLECTIONS = ["sites", "roles", "shift_types", "teams", "projects", "employees", "demand"] as const;

function isDocShaped(doc: unknown): doc is RequirementsDoc {
  if (typeof doc !== "object" || doc === null) return false;
  const d = doc as Record<string, unknown>;
  if (!DOC_COLLECTIONS.every((k) => Array.isArray(d[k]))) return false;
  // week_start is render-critical (the topbar range/picker and the stale-week check read
  // it before the backend ever validates the doc) — absent is fine, malformed is not.
  return d.week_start == null
    || (typeof d.week_start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.week_start));
}

export function loadSession(): SavedSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as SavedSession;
    // Deep-enough shape check: the app renders every collection of the doc and reads
    // `ui.*` before the backend ever sees the session, so anything render-critical is
    // verified (or defaulted) HERE. Semantic validity still comes from the backend —
    // a stale-but-shaped doc surfaces as normal requirement errors, never a crash.
    if (s?.v !== 1 || !isDocShaped(s.req)
      || typeof s.assignments !== "object" || s.assignments === null || Array.isArray(s.assignments)) {
      return null;
    }
    const ui: Partial<SavedUi> = typeof s.ui === "object" && s.ui !== null ? s.ui : {};
    return {
      ...s,
      draft: isDocShaped(s.draft) ? s.draft : null,
      carryover: typeof s.carryover === "object" && s.carryover !== null && !Array.isArray(s.carryover)
        && typeof s.carryover.employees === "object" && s.carryover.employees !== null
        ? s.carryover : null,
      ui: {
        view: ui.view === "editor" ? "editor" : "schedule",
        scheduleView: ui.scheduleView === "site" || ui.scheduleView === "team" || ui.scheduleView === "employee"
          ? ui.scheduleView : "project",
        siteId: typeof ui.siteId === "string" ? ui.siteId : "",
        projectId: typeof ui.projectId === "string" ? ui.projectId : "",
      },
    };
  } catch {
    return null; // corrupt JSON or storage unavailable — start from the seed
  }
}

export function saveSession(s: Omit<SavedSession, "v" | "savedAt">): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: 1, savedAt: new Date().toISOString(), ...s }));
  } catch {
    // Quota exceeded or storage unavailable — autosave silently degrades; the app keeps working.
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}
