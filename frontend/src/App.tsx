import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { build as apiBuild, getRequirements, ServerUnreachableError, solve as apiSolve, validate as apiValidate } from "./api";
import type {
  Assignments, CarryoverSeed, Dataset, Flag, RequirementsDoc, ScoreInfo,
} from "./types";
import { countFilled, siteIssues } from "./lib/lookups";
import { useI18n, type MsgKey } from "./lib/i18n";
import { currentWeekStart, fmtDay, fmtWeekRange, localDate, weekStartOf } from "./lib/dates";
import { clearSession, loadSession, saveSession } from "./lib/persist";
import ScheduleGrid from "./components/ScheduleGrid";
import ProjectView from "./components/ProjectView";
import RosterView from "./components/RosterView";
import SidePanel from "./components/SidePanel";
import PrintSchedule from "./components/PrintSchedule";
import Editor from "./components/Editor";
import ErrorBoundary from "./components/ErrorBoundary";
import { downloadText, scheduleCsv } from "./lib/scheduleExport";

type View = "schedule" | "editor";
// Phase 6: how the schedule is laid out. Site is the editable seat grid; the rest are
// read-only lenses on the same data — Project is seat-centric (cross-team), Team & Employee
// are people-as-rows rosters. (Round 2 #3: order Project · Team · Employee · Site, default
// Project; all four become editable for assignments — see ScheduleView usage below.)
type ScheduleView = "site" | "team" | "project" | "employee";
// ids are stable (persisted in the session, used in testids); labels translate at render.
const SCHEDULE_VIEWS: { id: ScheduleView; labelKey: MsgKey }[] = [
  { id: "project", labelKey: "viewProject" }, { id: "team", labelKey: "viewTeam" },
  { id: "employee", labelKey: "viewEmployee" }, { id: "site", labelKey: "viewSite" },
];

function emptyAssignments(ds: Dataset | null): Assignments {
  const a: Assignments = {};
  if (ds) for (const s of ds.seats) a[s.id] = null;
  return a;
}

export default function App() {
  const { lang, setLang, t } = useI18n();
  // Autosave restore (synchronous, once): a saved session — committed doc, unsaved draft,
  // assignments, applied carry-over seed, UI position — takes the place of the server seed
  // so a refresh loses nothing. "Reset to seed" (in the editor) clears it.
  const [restored] = useState(loadSession);
  const [req, setReq] = useState<RequirementsDoc | null>(restored?.req ?? null);
  // Round 2 #1: the editor edits a LOCAL draft; nothing rebuilds/validates until Save
  // commits it to `req`. Lifting the draft to App (not Editor-local) keeps unsaved edits
  // alive across view switches. `dirty` = the draft differs from the committed doc.
  const [draft, setDraft] = useState<RequirementsDoc | null>(null);
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [assignments, setAssignments] = useState<Assignments>({});
  const [score, setScore] = useState<ScoreInfo | null>(null);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [view, setView] = useState<View>(restored?.ui.view ?? "schedule");
  const [scheduleView, setScheduleView] = useState<ScheduleView>(restored?.ui.scheduleView ?? "project");
  const [solving, setSolving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [building, setBuilding] = useState(false);  // a committed-doc rebuild is in flight
  const [siteId, setSiteId] = useState<string>(restored?.ui.siteId ?? "");
  const [fatal, setFatal] = useState<string | null>(null);
  // Ask-on-load (locked decision, 2026-07-02): a RESTORED session whose week is strictly
  // before today's week gets a one-shot choice — stay on the saved week, or start the
  // current one. Fresh starts never ask: the server already hands out the current week.
  const [staleWeekAsk, setStaleWeekAsk] = useState<{ oldWeek: string; newWeek: string } | null>(() => {
    const saved = restored?.req?.week_start;
    const cur = currentWeekStart();
    return saved && saved < cur ? { oldWeek: saved, newWeek: cur } : null;
  });
  // Carry-over (ADR-0002): `carryover` is the seed currently applied to this week;
  // `nextCarryover` is the seed the latest solve/validate produced for the NEXT week.
  const [carryover, setCarryover] = useState<CarryoverSeed | null>(restored?.carryover ?? null);
  const [nextCarryover, setNextCarryover] = useState<CarryoverSeed | null>(null);
  // Undo/redo for assignment overrides. Each entry is a full assignments snapshot —
  // cheap (one id per seat) and immune to ordering bugs. Both stacks clear whenever the
  // schedule is re-baselined (rebuild, solve, carry-forward): the seat ids they reference
  // may no longer exist, and "undo past a solve" has no meaningful semantics.
  const [undoStack, setUndoStack] = useState<Assignments[]>([]);
  const [redoStack, setRedoStack] = useState<Assignments[]>([]);
  const reqToken = useRef(0);
  const buildToken = useRef(0);
  // One-shot restore payloads, consumed by the effects that would otherwise reset them:
  // the build effect (assignments) and the draft-resync effect (unsaved draft).
  const restoreAssignments = useRef<Assignments | null>(restored?.assignments ?? null);
  const restoreDraft = useRef<RequirementsDoc | null>(restored?.draft ?? null);

  // An unreachable backend (api.ts wraps ONLY fetch-level rejections in this error) —
  // a raw "TypeError: Failed to fetch" reads like a code bug, so translate it into what
  // the user can act on (start/wait for the server; the autosaved session means no loss).
  // Any other error keeps its real message.
  const fatalOf = useCallback(
    (e: unknown) => (e instanceof ServerUnreachableError ? t("serverUnreachable") : String(e)),
    [t]);

  // load the seed requirements (re-runnable so the initial-load fatal screen can retry).
  // Skipped when a saved session was restored — the session IS the document of record.
  const loadRequirements = useCallback(() => {
    setFatal(null);
    getRequirements().then(setReq).catch((e) => setFatal(fatalOf(e)));
  }, [fatalOf]);
  useEffect(() => {
    if (!restored) loadRequirements();
  }, [loadRequirements, restored]);

  // Resync the editor draft whenever the committed doc changes — initial load, a Save
  // (req becomes the draft, so this is a no-op), carry-forward, or an import. This is the
  // "resync to the committed req when it changes externally" rule from Round 2 #1.
  // A restored unsaved draft wins as long as the committed doc is still the restored one
  // (idempotent on purpose: StrictMode double-runs effects in dev, so consuming the ref on
  // the first pass would let the second pass clobber the restored draft with `req`).
  useEffect(() => {
    if (restoreDraft.current && req === restored?.req) {
      setDraft(restoreDraft.current);
    } else {
      restoreDraft.current = null;
      setDraft(req);
    }
  }, [req, restored]);

  // Unsaved edits exist when the draft diverges from the committed doc. A value compare
  // (not reference) so a Save — which makes req === draft by value — clears it.
  const dirty = useMemo(
    () => req != null && draft != null && JSON.stringify(draft) !== JSON.stringify(req),
    [req, draft],
  );

  // Re-check the week against `next` assignments — the shared tail of every assignment
  // mutation (override, undo/redo, session restore). Token-guarded exactly like solve:
  // a newer edit supersedes an in-flight response.
  const revalidate = useCallback(async (next: Assignments) => {
    if (!req) return;
    const token = ++reqToken.current;
    setSolving(false);     // supersede any in-flight solve (shared token)
    setValidating(true);
    try {
      const r = await apiValidate(req, next, carryover ?? undefined);
      if (token === reqToken.current) {
        // Surface a rejected validate (e.g. a stale seat id) instead of silently keeping
        // the previous score/flags — mirrors handleSolve. r.score is null on rejection.
        setErrors(r.errors);
        setWarnings(r.warnings);
        if (r.score) {
          setScore(r.score);
          setFlags(r.flags);
          setNextCarryover(r.next_carryover);   // seed reflects the latest overrides
        } else {
          // Rejected: the prior score/flags/seed no longer describe these assignments,
          // so clear them rather than leaving a stale result badge/panel visible.
          setScore(null);
          setFlags([]);
          setNextCarryover(null);
        }
      }
    } catch (e) {
      setFatal(fatalOf(e));
    } finally {
      if (token === reqToken.current) setValidating(false);
    }
  }, [req, carryover]);

  // rebuild (materialise) whenever the requirements change — debounced.
  // Editing the org invalidates any existing solution, so the schedule resets.
  useEffect(() => {
    if (!req) return;
    // Invalidate the stale next-week seed IMMEDIATELY (not after the debounce), so
    // the "Carry to next week" button can't be clicked during the rebuild window.
    setNextCarryover(null);
    // `building` is true from the moment the committed doc changes until /api/build
    // settles. It gates Solve/Carry so a Save of a now-invalid doc can't briefly leave
    // the old (feasible) score on screen with Generate enabled (codex finding #1).
    setBuilding(true);
    const token = ++buildToken.current;
    const h = setTimeout(async () => {
      try {
        const r = await apiBuild(req, carryover ?? undefined);
        if (token !== buildToken.current) return;
        setErrors(r.errors);
        setWarnings(r.warnings);
        setDataset(r.dataset);
        setScore(null);
        setFlags([]);
        // A rebuild re-baselines the schedule: history entries reference seat ids that
        // may no longer exist, so both stacks reset.
        setUndoStack([]);
        setRedoStack([]);
        // Session restore (one-shot): re-apply the saved assignments onto the freshly
        // built seats — keeping only seats that still exist and employees still known —
        // then re-validate so score/flags/next-week seed reflect them again.
        const saved = restoreAssignments.current;
        restoreAssignments.current = null;
        const next = emptyAssignments(r.dataset);
        let restoredAny = false;
        if (r.dataset && saved) {
          const empIds = new Set(r.dataset.employees.map((e) => e.id));
          for (const seat of r.dataset.seats) {
            const emp = saved[seat.id];
            if (emp && empIds.has(emp)) {
              next[seat.id] = emp;
              restoredAny = true;
            }
          }
        }
        setAssignments(next);
        if (restoredAny) void revalidate(next);
        if (r.dataset) {
          // Functional update: the user may have switched site tabs while this build was
          // in flight — validate against the CURRENT selection, not the captured one.
          const sites = r.dataset.sites;
          setSiteId((cur) => (sites.some((s) => s.id === cur) ? cur : sites[0]?.id ?? ""));
        }
      } catch (e) {
        setFatal(fatalOf(e));
      } finally {
        if (token === buildToken.current) setBuilding(false);
      }
    }, 350);
    return () => clearTimeout(h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req, carryover]);

  // `reqToken` is the op-generation guard: every solve/validate captures it and
  // refuses to write its (possibly stale) response — score, flags, next-week seed —
  // if a newer override or requirements change has since bumped it. This is what
  // stops an in-flight response from repopulating a stale nextCarryover after the
  // org changed. Spinners reset unconditionally so a superseded op never leaves one stuck.
  const handleSolve = useCallback(async () => {
    if (!req) return;
    ++buildToken.current;              // cancel any pending debounced build
    const token = ++reqToken.current;  // this op is the latest; older responses bail
    setValidating(false);              // supersede any in-flight validate (shared token)
    setSolving(true);
    try {
      const r = await apiSolve(req, undefined, carryover ?? undefined);
      if (token !== reqToken.current) return;   // a newer edit/override superseded us
      setErrors(r.errors);
      setWarnings(r.warnings);
      if (r.errors.length > 0 || !r.dataset) {
        setView("editor");
        return;
      }
      setDataset(r.dataset);
      setAssignments(r.assignments);
      // The solved schedule is a new baseline — undoing "past" it would replay
      // pre-solve assignments that no longer describe anything meaningful.
      setUndoStack([]);
      setRedoStack([]);
      setScore(r.score);
      setFlags(r.flags);
      setNextCarryover(r.next_carryover);
      setView("schedule");
      {
        const sites = r.dataset.sites;
        setSiteId((cur) => (sites.some((s) => s.id === cur) ? cur : sites[0]?.id ?? ""));
      }
    } catch (e) {
      setFatal(fatalOf(e));
    } finally {
      // Only the latest op clears its spinner (avoids an early hide while a newer
      // op is still in flight); a superseding edit clears it synchronously instead.
      if (token === reqToken.current) setSolving(false);
    }
  }, [req, carryover]);

  const handleChange = useCallback(
    (seatId: string, employeeId: string | null) => {
      if (!req) return;
      const next = { ...assignments, [seatId]: employeeId };
      // Every override is an undoable step; a fresh edit forks history (clears redo).
      // Capped at 50 snapshots — beyond that the oldest fall off.
      setUndoStack((u) => [...u.slice(-49), assignments]);
      setRedoStack([]);
      setAssignments(next);
      void revalidate(next);
    },
    [req, assignments, revalidate],
  );

  // Undo/redo replay a snapshot and re-validate it — the same immediate-override
  // contract as a manual change. No-ops while assignment editing is locked (unsaved
  // requirement edits / rebuild in flight), while a solve is running (an undo would
  // silently supersede and discard the solve), and outside the schedule view (a
  // reflexive ⌘Z in the editor must never invisibly rewind an assignment).
  const locked = dirty || building;
  const handleUndo = useCallback(() => {
    if (undoStack.length === 0 || locked || solving || view !== "schedule") return;
    const prev = undoStack[undoStack.length - 1];
    setUndoStack((u) => u.slice(0, -1));
    setRedoStack((r) => [...r, assignments]);
    setAssignments(prev);
    void revalidate(prev);
  }, [undoStack, locked, solving, view, assignments, revalidate]);
  const handleRedo = useCallback(() => {
    if (redoStack.length === 0 || locked || solving || view !== "schedule") return;
    const next = redoStack[redoStack.length - 1];
    setRedoStack((r) => r.slice(0, -1));
    setUndoStack((u) => [...u, assignments]);
    setAssignments(next);
    void revalidate(next);
  }, [redoStack, locked, solving, view, assignments, revalidate]);

  // ⌘Z / Ctrl+Z undoes, ⇧⌘Z / Ctrl+Shift+Z redoes — except while typing in a field,
  // where the browser's own text undo must keep working.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
      e.preventDefault();
      if (e.shiftKey) handleRedo();
      else handleUndo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleUndo, handleRedo]);

  // Edits to the org invalidate any seed derived from the now-stale schedule, AND
  // any in-flight solve/validate (via the reqToken bump). Clearing nextCarryover in
  // the SAME update as setReq guarantees no committed render shows a stale,
  // clickable Carry button (the build-effect clear is only a backstop).
  const handleRequirementsChange = useCallback((next: RequirementsDoc) => {
    ++reqToken.current;       // bail any in-flight solve/validate write
    ++buildToken.current;     // bail any in-flight build before its microtask resolves
    setNextCarryover(null);
    setSolving(false);        // a superseded op won't clear its own spinner (token-gated)
    setValidating(false);
    // Invalidate the now-stale solution synchronously so the badge resets to "Not solved"
    // immediately on Save (not after the debounced build) — no stale feasible score window.
    setScore(null);
    setFlags([]);
    // A seed only applies to the week it targets (ADR-0002; the backend hard-rejects a
    // mismatch). If the committed doc's week changed — a week_start edit, or an import of
    // a doc from another week — drop the seed instead of letting it block every build.
    setCarryover((cur) =>
      cur && cur.target_week_start !== (next.week_start ?? null) ? null : cur);
    // Mark a rebuild in flight in the SAME commit (not only later in the build effect), so
    // there's no render where dirty=false, building=false and an enabled Solve slips through.
    setBuilding(true);
    setReq(next);             // the draft-resync effect mirrors this back onto `draft`
  }, []);

  // An import replaces the document of record wholesale — the imported doc's own
  // carry-over fields are now the truth, so any applied seed must not overwrite them
  // (even when the weeks happen to match).
  const handleImportCommit = useCallback((next: RequirementsDoc) => {
    setCarryover(null);
    handleRequirementsChange(next);
  }, [handleRequirementsChange]);

  // The inert "seeded" tag becomes an actionable control: drop the applied seed and
  // rebuild the week from the document's own carry-over fields. Invalidate synchronously,
  // exactly like a requirements change — an in-flight validate started UNDER the old seed
  // must not write its score/flags/next-week seed after the seed is gone, and the Carry
  // button must not stay clickable during the rebuild window.
  const handleRemoveSeed = useCallback(() => {
    ++reqToken.current;
    ++buildToken.current;
    setNextCarryover(null);
    setSolving(false);
    setValidating(false);
    setScore(null);
    setFlags([]);
    setBuilding(true);      // the build effect re-runs on the carryover change below
    setCarryover(null);
  }, []);

  // Round 2 #1: Save commits the draft (→ rebuild via the build effect); Discard reverts
  // the draft to the committed doc. Both are no-ops when there's nothing to do.
  const handleSave = useCallback(() => {
    if (draft && dirty) handleRequirementsChange(draft);
  }, [draft, dirty, handleRequirementsChange]);
  const handleDiscard = useCallback(() => { setDraft(req); }, [req]);

  // Advance to the next week, seeded by the accepted schedule's carry-over
  // (ADR-0002). Bumps week_start to the seed's target week and applies the seed;
  // the build effect then re-materialises the (empty) next week.
  const handleCarryForward = useCallback(() => {
    if (!req || !nextCarryover?.target_week_start) return;
    ++reqToken.current;    // invalidate any in-flight solve/validate for the old week
    ++buildToken.current;  // and any in-flight build
    // Reset the displayed schedule synchronously so the new (unsolved) week never
    // shows the prior week's solved grid during the debounced rebuild.
    setScore(null);
    setFlags([]);
    setSolving(false);
    setValidating(false);
    setAssignments(emptyAssignments(dataset));
    setUndoStack([]);   // new week, new baseline — history from the old week is meaningless
    setRedoStack([]);
    setReq({ ...req, week_start: nextCarryover.target_week_start });
    setCarryover(nextCarryover);
    setNextCarryover(null);
    setView("schedule");
  }, [req, nextCarryover, dataset]);

  // Week navigation (picker + stale-week jump): changing the week is a REQUIREMENTS
  // edit — it restructures the schedule — so it flows through handleRequirementsChange
  // (score resets, the build effect re-materialises, and a week-mismatched carry-over
  // seed is dropped there). Assignments/history clear synchronously, exactly like
  // carry-forward: the old week's solved grid must not linger through the rebuild.
  const handleWeekChange = useCallback((weekStart: string) => {
    if (!req || !weekStart || weekStart === req.week_start) return;
    setAssignments(emptyAssignments(dataset));
    setUndoStack([]);
    setRedoStack([]);
    handleRequirementsChange({ ...req, week_start: weekStart });
  }, [req, dataset, handleRequirementsChange]);

  const handleStaleWeekStay = useCallback(() => setStaleWeekAsk(null), []);
  // Gated on `dirty` exactly like the week picker: a restored session can carry an
  // UNSAVED editor draft, and jumping would commit a new doc — the draft-resync rule
  // would then silently discard those edits. Stay first, resolve the draft, then pick.
  const handleStaleWeekJump = useCallback(() => {
    if (!staleWeekAsk || dirty) return;
    setStaleWeekAsk(null);
    handleWeekChange(staleWeekAsk.newWeek);
  }, [staleWeekAsk, dirty, handleWeekChange]);

  // Autosave (debounced): persist the whole working session on every meaningful change.
  // Score/flags/next-week seed are NOT stored — restore recomputes them via revalidate,
  // so the persisted shape can never disagree with the scoring authority.
  useEffect(() => {
    if (!req) return;
    const h = setTimeout(() => {
      saveSession({
        req,
        draft: dirty && draft ? draft : null,
        assignments,
        carryover,
        ui: { view, scheduleView, siteId },
      });
    }, 300);
    return () => clearTimeout(h);
  }, [req, draft, dirty, assignments, carryover, view, scheduleView, siteId]);

  // "Reset to seed": drop the saved session AND the working document, and start over
  // from the server's seed requirements — the escape hatch out of any restored state.
  // Fetch FIRST: nothing is destroyed until the replacement doc is in hand, so a failed
  // fetch leaves the session, seed and document fully intact.
  const handleResetToSeed = useCallback(async () => {
    try {
      const seed = await getRequirements();
      clearSession();
      restoreAssignments.current = null;
      restoreDraft.current = null;
      setCarryover(null);
      handleRequirementsChange(seed);   // resets score/flags/seed + rebuilds via the build effect
    } catch (e) {
      setFatal(fatalOf(e));
    }
  }, [handleRequirementsChange]);

  const issues = useMemo(() => (dataset ? siteIssues(dataset, assignments) : {}), [dataset, assignments]);

  if (fatal && !req) return (
    <div className="fatal" role="alert" data-testid="fatal-screen">
      <div className="fatal__box">
        <strong>{t("failedLoad")}</strong>
        <p className="fatal__msg">{fatal}</p>
        <div className="fatal__actions">
          <button className="btn btn--primary" data-testid="fatal-retry" onClick={loadRequirements}>{t("tryAgain")}</button>
          <button className="btn" data-testid="fatal-reload" onClick={() => window.location.reload()}>{t("reloadPage")}</button>
        </div>
      </div>
    </div>
  );
  if (!req) return <div className="loading">{t("loading")}</div>;

  const { filled, total } = dataset ? countFilled(dataset, assignments) : { filled: 0, total: 0 };
  // From the committed doc (not the built dataset) so the range never blanks out during a
  // rebuild; the seed fallback mirrors the server's default when week_start is absent.
  const weekStart = req.week_start ?? dataset?.week_start ?? null;
  const weekRange = weekStart ? fmtWeekRange(weekStart, lang) : "";
  const teams = dataset ? dataset.teams.filter((t) => t.site_id === siteId) : [];
  const blocked = errors.length > 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <h1>{t("appTitle")}</h1>
          <span className="topbar__site">
            {req.sites.length} {t("sites")} · {req.employees.length} {t("people")}
            {/* <bdi>: an LTR date range embedded in RTL text bidi-scrambles without it */}
            {weekRange && <>{" · "}<bdi data-testid="week-range">{weekRange}</bdi></>}
            <input type="date" className="weekpick" data-testid="week-picker"
              value={weekStart ?? ""} disabled={locked || solving}
              title={t("weekPickerTitle")} aria-label={t("weekPickerTitle")}
              onChange={(e) => e.target.value && handleWeekChange(weekStartOf(localDate(e.target.value)))} />
            {carryover && (
              <span className="topbar__seeded" data-testid="seeded-tag">{" · "}{t("seededTag")}
                <button className="seeded__rm" data-testid="remove-seed" onClick={handleRemoveSeed}
                  title={t("removeSeedTitle")}>×</button>
              </span>
            )}
          </span>
        </div>
        <div className="topbar__actions">
          <div className="viewtabs" role="tablist">
            <button className={`viewtab${view === "schedule" ? " is-active" : ""}`} data-testid="nav-schedule"
              data-active={view === "schedule"} onClick={() => setView("schedule")}>{t("navSchedule")}</button>
            <button className={`viewtab${view === "editor" ? " is-active" : ""}`} data-testid="nav-editor"
              data-active={view === "editor"} onClick={() => setView("editor")}>
              {t("navRequirements")}{blocked ? ` (${errors.length}⚠)` : ""}
              {dirty && <span className="viewtab__dirty" data-testid="nav-editor-dirty" title={t("unsavedDot")}>&nbsp;●</span>}
            </button>
          </div>
          {view === "schedule" && (
            <div className="histbtns" role="group" aria-label="Undo / redo assignment changes">
              <button className="btn btn--sm btn--icon" data-testid="undo-button" onClick={handleUndo}
                disabled={undoStack.length === 0 || locked}
                title={t("undoTitle")}>↶</button>
              <button className="btn btn--sm btn--icon" data-testid="redo-button" onClick={handleRedo}
                disabled={redoStack.length === 0 || locked}
                title={t("redoTitle")}>↷</button>
            </div>
          )}
          <ScoreBadge score={score} filled={filled} total={total} />
          <button className="btn btn--primary" data-testid="solve-button" onClick={handleSolve}
            disabled={solving || blocked || dirty || building}
            title={dirty ? t("saveFirst") : blocked ? t("fixErrorsFirst") : ""}>
            {solving ? t("solving") : score ? t("resolve") : t("solve")}
          </button>
          {nextCarryover?.target_week_start && (
            <button className="btn" data-testid="carry-button" onClick={handleCarryForward}
              disabled={solving || validating || blocked || dirty || building}
              title={dirty ? t("saveFirst")
                : t("carryTitle", { week: fmtDay(nextCarryover.target_week_start, lang) })}>
              {t("carryTo")} {fmtDay(nextCarryover.target_week_start, lang)} →
            </button>
          )}
          <button className="btn btn--sm" data-testid="lang-toggle" title={t("langToggleTitle")}
            onClick={() => setLang(lang === "he" ? "en" : "he")}>{lang === "he" ? "EN" : "עב"}</button>
        </div>
      </header>

      {staleWeekAsk && (
        <div className="modal" data-testid="stale-week-dialog" role="dialog" aria-modal="true"
          aria-labelledby="stale-week-title">
          <div className="modal__box">
            <h2 id="stale-week-title" className="modal__title">{t("staleWeekTitle")}</h2>
            <p className="modal__body">
              {t("staleWeekBody", {
                old: fmtWeekRange(staleWeekAsk.oldWeek, lang),
                new: fmtWeekRange(staleWeekAsk.newWeek, lang),
              })}
            </p>
            <div className="modal__actions">
              <button className="btn" data-testid="stale-week-stay" onClick={handleStaleWeekStay}>
                {t("staleWeekStay", { old: fmtDay(staleWeekAsk.oldWeek, lang) })}
              </button>
              <button className="btn btn--primary" data-testid="stale-week-jump" onClick={handleStaleWeekJump}
                disabled={dirty} title={dirty ? t("saveFirst") : ""}>
                {t("staleWeekJump")}
              </button>
            </div>
          </div>
        </div>
      )}

      {fatal && (
        <div className="banner banner--error" data-testid="fatal-banner" role="alert">
          {t("fatalPrefix")} {fatal}
          <button className="banner__dismiss" data-testid="fatal-dismiss"
            onClick={() => setFatal(null)}>{t("dismiss")}</button>
        </div>
      )}

      {view === "editor" ? (
        <main className="editorwrap">
          <ErrorBoundary resetKey="editor">
            <Editor draft={draft ?? req} onDraftChange={setDraft} onCommit={handleImportCommit}
              onSave={handleSave} onDiscard={handleDiscard} dirty={dirty}
              errors={errors} warnings={warnings} carryoverSeed={carryover}
              onResetToSeed={handleResetToSeed} />
          </ErrorBoundary>
        </main>
      ) : (
        <>
          {/* The view-by nav + sitebar stay OUTSIDE the boundary so a crashed view can be
              escaped by switching views/sites (which also bumps the boundary resetKey). */}
          <nav className="viewby" data-testid="view-by" aria-label="View by">
            <span className="viewby__label">{t("viewBy")}</span>
            {SCHEDULE_VIEWS.map((v) => (
              <button key={v.id} className={`viewby__btn${scheduleView === v.id ? " is-active" : ""}`}
                data-testid={`viewby-${v.id}`} data-active={scheduleView === v.id}
                onClick={() => setScheduleView(v.id)}>{t(v.labelKey)}</button>
            ))}
            {/* Round 2 #2/#4: every view now allows assignment overrides (Project also edits
                requirements via draft→Save), so there is no read-only lens anymore. */}
            <span className="viewby__spacer" />
            <button className="btn btn--sm" data-testid="print-button" disabled={!dataset}
              onClick={() => window.print()}
              title={t("printTitle")}>
              {t("print")}
            </button>
            <button className="btn btn--sm" data-testid="export-schedule-csv" disabled={!dataset}
              onClick={() => dataset && downloadText(
                `schedule-${dataset.week_start}.csv`, scheduleCsv(dataset, assignments), "text/csv")}
              title={t("scheduleCsvTitle")}>
              {t("scheduleCsv")}
            </button>
          </nav>

          {dataset && scheduleView === "site" && (
            <nav className="sitebar" data-testid="sitebar" aria-label="Sites">
              {dataset.sites.map((s) => {
                const iss = issues[s.id];
                const count = score ? (iss?.unfilled ?? 0) + (iss?.exceptional ?? 0) : 0;
                return (
                  <button key={s.id} className={`sitetab${s.id === siteId ? " is-active" : ""}`}
                    data-testid="site-tab" data-site-id={s.id} data-active={s.id === siteId}
                    onClick={() => setSiteId(s.id)}>
                    <span className="sitetab__name">{s.name}</span>
                    {count > 0 && <span className="sitetab__count" data-testid="site-issue-count">{count}</span>}
                  </button>
                );
              })}
            </nav>
          )}

          <main className="layout">
            <ErrorBoundary resetKey={scheduleView}>
              <div className="layout__main">
                {blocked ? (
                  <div className="banner banner--error" data-testid="blocked-banner" role="alert">
                    {t("errorsBanner", { n: errors.length })}
                  </div>
                ) : !score && !solving ? (
                  <div className="hint" data-testid="presolve-hint">
                    {t("presolveHint1")} <strong>{t("solve")}</strong> {t("presolveHint2")}{" "}
                    <strong>{t("navRequirements")}</strong>.
                  </div>
                ) : null}
                {dataset && scheduleView === "site" &&
                  <ScheduleGrid ds={dataset} teams={teams} assignments={assignments} onChange={handleChange} locked={locked || solving} dirty={dirty} />}
                {dataset && scheduleView === "team" &&
                  <RosterView ds={dataset} assignments={assignments} groupByTeam
                    onChange={handleChange} locked={locked || solving} dirty={dirty} />}
                {dataset && scheduleView === "employee" &&
                  <RosterView ds={dataset} assignments={assignments} groupByTeam={false}
                    onChange={handleChange} locked={locked || solving} dirty={dirty} />}
                {dataset && scheduleView === "project" &&
                  <ProjectView ds={dataset} assignments={assignments}
                    draft={draft ?? req} onDraftChange={setDraft} onSave={handleSave}
                    onDiscard={handleDiscard} dirty={dirty} building={building} solving={solving} onChange={handleChange} />}
              </div>
            </ErrorBoundary>
            <SidePanel flags={flags} score={score} validating={validating}
              ds={dataset} assignments={assignments} />
          </main>
          {/* Direct child of .app: @media print hides its siblings and shows only this. */}
          <PrintSchedule ds={dataset} assignments={assignments} />
        </>
      )}
    </div>
  );
}

function ScoreBadge({ score, filled, total }: { score: ScoreInfo | null; filled: number; total: number }) {
  const { t } = useI18n();
  if (!score) {
    return <span className="badge badge--idle" data-testid="score-badge" data-feasible="unknown">{t("notSolved")}</span>;
  }
  return (
    <span className={`badge ${score.feasible ? "badge--ok" : "badge--bad"}`}
      data-testid="score-badge" data-feasible={score.feasible} data-filled={filled} data-total={total}
      data-medium={score.medium_score} data-soft={score.soft_score}>
      <span className="badge__dot" aria-hidden />
      {score.feasible ? t("feasible") : t("infeasible")}
      <span className="badge__sep">·</span>{filled}/{total} {t("filled")}
      {score.medium_score < 0 && (
        <><span className="badge__sep">·</span>{t("coverage")} −{Math.abs(score.medium_score)}</>
      )}
      <span className="badge__sep">·</span>{t("penalty")} {Math.abs(score.soft_score)}
    </span>
  );
}
