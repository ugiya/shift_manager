import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { build as apiBuild, getRequirements, solve as apiSolve, validate as apiValidate } from "./api";
import type {
  Assignments, CarryoverSeed, Dataset, Flag, RequirementsDoc, ScoreInfo,
} from "./types";
import { countFilled, siteIssues } from "./lib/lookups";
import ScheduleGrid from "./components/ScheduleGrid";
import ProjectView from "./components/ProjectView";
import RosterView from "./components/RosterView";
import FlagsPanel from "./components/FlagsPanel";
import Editor from "./components/Editor";
import ErrorBoundary from "./components/ErrorBoundary";

type View = "schedule" | "editor";
// Phase 6: how the schedule is laid out. Site is the editable seat grid; the rest are
// read-only lenses on the same data — Project is seat-centric (cross-team), Team & Employee
// are people-as-rows rosters. (Round 2 #3: order Project · Team · Employee · Site, default
// Project; all four become editable for assignments — see ScheduleView usage below.)
type ScheduleView = "site" | "team" | "project" | "employee";
const SCHEDULE_VIEWS: { id: ScheduleView; label: string }[] = [
  { id: "project", label: "Project" }, { id: "team", label: "Team" },
  { id: "employee", label: "Employee" }, { id: "site", label: "Site" },
];

function emptyAssignments(ds: Dataset | null): Assignments {
  const a: Assignments = {};
  if (ds) for (const s of ds.seats) a[s.id] = null;
  return a;
}

export default function App() {
  const [req, setReq] = useState<RequirementsDoc | null>(null);
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
  const [view, setView] = useState<View>("schedule");
  const [scheduleView, setScheduleView] = useState<ScheduleView>("project");
  const [solving, setSolving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [building, setBuilding] = useState(false);  // a committed-doc rebuild is in flight
  const [siteId, setSiteId] = useState<string>("");
  const [fatal, setFatal] = useState<string | null>(null);
  // Carry-over (ADR-0002): `carryover` is the seed currently applied to this week;
  // `nextCarryover` is the seed the latest solve/validate produced for the NEXT week.
  const [carryover, setCarryover] = useState<CarryoverSeed | null>(null);
  const [nextCarryover, setNextCarryover] = useState<CarryoverSeed | null>(null);
  const reqToken = useRef(0);
  const buildToken = useRef(0);

  // load the seed requirements (re-runnable so the initial-load fatal screen can retry).
  const loadRequirements = useCallback(() => {
    setFatal(null);
    getRequirements().then(setReq).catch((e) => setFatal(String(e)));
  }, []);
  useEffect(() => { loadRequirements(); }, [loadRequirements]);

  // Resync the editor draft whenever the committed doc changes — initial load, a Save
  // (req becomes the draft, so this is a no-op), carry-forward, or an import. This is the
  // "resync to the committed req when it changes externally" rule from Round 2 #1.
  useEffect(() => { setDraft(req); }, [req]);

  // Unsaved edits exist when the draft diverges from the committed doc. A value compare
  // (not reference) so a Save — which makes req === draft by value — clears it.
  const dirty = useMemo(
    () => req != null && draft != null && JSON.stringify(draft) !== JSON.stringify(req),
    [req, draft],
  );

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
        setAssignments(emptyAssignments(r.dataset));
        setScore(null);
        setFlags([]);
        if (r.dataset && !r.dataset.sites.some((s) => s.id === siteId)) {
          setSiteId(r.dataset.sites[0]?.id ?? "");
        }
      } catch (e) {
        setFatal(String(e));
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
      setScore(r.score);
      setFlags(r.flags);
      setNextCarryover(r.next_carryover);
      setView("schedule");
      if (!r.dataset.sites.some((s) => s.id === siteId)) setSiteId(r.dataset.sites[0]?.id ?? "");
    } catch (e) {
      setFatal(String(e));
    } finally {
      // Only the latest op clears its spinner (avoids an early hide while a newer
      // op is still in flight); a superseding edit clears it synchronously instead.
      if (token === reqToken.current) setSolving(false);
    }
  }, [req, siteId, carryover]);

  const handleChange = useCallback(
    async (seatId: string, employeeId: string | null) => {
      if (!req) return;
      const next = { ...assignments, [seatId]: employeeId };
      setAssignments(next);
      const token = ++reqToken.current;
      setSolving(false);     // supersede any in-flight solve (shared token)
      setValidating(true);
      try {
        const r = await apiValidate(req, next, carryover ?? undefined);
        if (token === reqToken.current && r.score) {
          setScore(r.score);
          setFlags(r.flags);
          setNextCarryover(r.next_carryover);   // seed reflects the latest overrides
        }
      } catch (e) {
        setFatal(String(e));
      } finally {
        if (token === reqToken.current) setValidating(false);
      }
    },
    [req, assignments, carryover],
  );

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
    // Mark a rebuild in flight in the SAME commit (not only later in the build effect), so
    // there's no render where dirty=false, building=false and an enabled Solve slips through.
    setBuilding(true);
    setReq(next);             // the draft-resync effect mirrors this back onto `draft`
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
    setReq({ ...req, week_start: nextCarryover.target_week_start });
    setCarryover(nextCarryover);
    setNextCarryover(null);
    setView("schedule");
  }, [req, nextCarryover, dataset]);

  const issues = useMemo(() => (dataset ? siteIssues(dataset, assignments) : {}), [dataset, assignments]);

  if (fatal && !req) return (
    <div className="fatal" role="alert" data-testid="fatal-screen">
      <div className="fatal__box">
        <strong>Failed to load the scheduler.</strong>
        <p className="fatal__msg">{fatal}</p>
        <div className="fatal__actions">
          <button className="btn btn--primary" data-testid="fatal-retry" onClick={loadRequirements}>Try again</button>
          <button className="btn" data-testid="fatal-reload" onClick={() => window.location.reload()}>Reload page</button>
        </div>
      </div>
    </div>
  );
  if (!req) return <div className="loading">Loading scheduler…</div>;

  const { filled, total } = dataset ? countFilled(dataset, assignments) : { filled: 0, total: 0 };
  const weekRange = dataset ? `${fmt(dataset.days[0])} – ${fmt(dataset.days[6])}` : "";
  const teams = dataset ? dataset.teams.filter((t) => t.site_id === siteId) : [];
  const blocked = errors.length > 0;

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar__brand">
          <h1>Shift Scheduler</h1>
          <span className="topbar__site">
            {req.sites.length} sites · {req.employees.length} people{weekRange ? ` · ${weekRange}` : ""}
            {carryover && <span className="topbar__seeded" data-testid="seeded-tag"> · seeded from prior week</span>}
          </span>
        </div>
        <div className="topbar__actions">
          <div className="viewtabs" role="tablist">
            <button className={`viewtab${view === "schedule" ? " is-active" : ""}`} data-testid="nav-schedule"
              data-active={view === "schedule"} onClick={() => setView("schedule")}>Schedule</button>
            <button className={`viewtab${view === "editor" ? " is-active" : ""}`} data-testid="nav-editor"
              data-active={view === "editor"} onClick={() => setView("editor")}>
              Requirements{blocked ? ` (${errors.length}⚠)` : ""}
              {dirty && <span className="viewtab__dirty" data-testid="nav-editor-dirty" title="Unsaved changes">&nbsp;●</span>}
            </button>
          </div>
          <ScoreBadge score={score} filled={filled} total={total} />
          <button className="btn btn--primary" data-testid="solve-button" onClick={handleSolve}
            disabled={solving || blocked || dirty || building}
            title={dirty ? "Save your requirement changes first" : blocked ? "Fix requirement errors first" : ""}>
            {solving ? "Solving…" : score ? "Re-solve" : "Generate schedule"}
          </button>
          {nextCarryover?.target_week_start && (
            <button className="btn" data-testid="carry-button" onClick={handleCarryForward}
              disabled={solving || validating || blocked || dirty || building}
              title={dirty ? "Save your requirement changes first"
                : `Seed the week of ${fmt(nextCarryover.target_week_start)} from this schedule`}>
              Carry to {fmt(nextCarryover.target_week_start)} →
            </button>
          )}
        </div>
      </header>

      {fatal && (
        <div className="banner banner--error" data-testid="fatal-banner" role="alert">
          Something went wrong: {fatal}
          <button className="banner__dismiss" data-testid="fatal-dismiss"
            onClick={() => setFatal(null)}>Dismiss</button>
        </div>
      )}

      {view === "editor" ? (
        <main className="editorwrap">
          <ErrorBoundary resetKey="editor">
            <Editor draft={draft ?? req} onDraftChange={setDraft} onCommit={handleRequirementsChange}
              onSave={handleSave} onDiscard={handleDiscard} dirty={dirty}
              errors={errors} warnings={warnings} />
          </ErrorBoundary>
        </main>
      ) : (
        <>
          {/* The view-by nav + sitebar stay OUTSIDE the boundary so a crashed view can be
              escaped by switching views/sites (which also bumps the boundary resetKey). */}
          <nav className="viewby" data-testid="view-by" aria-label="View by">
            <span className="viewby__label">View by:</span>
            {SCHEDULE_VIEWS.map((v) => (
              <button key={v.id} className={`viewby__btn${scheduleView === v.id ? " is-active" : ""}`}
                data-testid={`viewby-${v.id}`} data-active={scheduleView === v.id}
                onClick={() => setScheduleView(v.id)}>{v.label}</button>
            ))}
            {/* Round 2 #2/#4: every view now allows assignment overrides (Project also edits
                requirements via draft→Save), so there is no read-only lens anymore. */}
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
                    {errors.length} requirement error(s) — open <strong>Requirements</strong> to fix them.
                  </div>
                ) : !score && !solving ? (
                  <div className="hint" data-testid="presolve-hint">
                    Press <strong>Generate schedule</strong> to staff your org, then adjust any seat —
                    every change re-checks the whole schedule. Edit the org under <strong>Requirements</strong>.
                  </div>
                ) : null}
                {dataset && scheduleView === "site" &&
                  <ScheduleGrid ds={dataset} teams={teams} assignments={assignments} onChange={handleChange} locked={dirty || building} />}
                {dataset && scheduleView === "team" &&
                  <RosterView ds={dataset} assignments={assignments} groupByTeam
                    onChange={handleChange} locked={dirty || building} />}
                {dataset && scheduleView === "employee" &&
                  <RosterView ds={dataset} assignments={assignments} groupByTeam={false}
                    onChange={handleChange} locked={dirty || building} />}
                {dataset && scheduleView === "project" &&
                  <ProjectView ds={dataset} assignments={assignments}
                    draft={draft ?? req} onDraftChange={setDraft} onSave={handleSave}
                    onDiscard={handleDiscard} dirty={dirty} building={building} onChange={handleChange} />}
              </div>
            </ErrorBoundary>
            <FlagsPanel flags={flags} score={score} validating={validating} />
          </main>
        </>
      )}
    </div>
  );
}

function ScoreBadge({ score, filled, total }: { score: ScoreInfo | null; filled: number; total: number }) {
  if (!score) {
    return <span className="badge badge--idle" data-testid="score-badge" data-feasible="unknown">Not solved</span>;
  }
  return (
    <span className={`badge ${score.feasible ? "badge--ok" : "badge--bad"}`}
      data-testid="score-badge" data-feasible={score.feasible} data-filled={filled} data-total={total}
      data-medium={score.medium_score} data-soft={score.soft_score}>
      <span className="badge__dot" aria-hidden />
      {score.feasible ? "Feasible" : "Infeasible"}
      <span className="badge__sep">·</span>{filled}/{total} filled
      {score.medium_score < 0 && (
        <><span className="badge__sep">·</span>coverage −{Math.abs(score.medium_score)}</>
      )}
      <span className="badge__sep">·</span>penalty {Math.abs(score.soft_score)}
    </span>
  );
}

function fmt(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
