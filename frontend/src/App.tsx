import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { build as apiBuild, getRequirements, solve as apiSolve, validate as apiValidate } from "./api";
import type {
  Assignments, CarryoverSeed, Dataset, Flag, RequirementsDoc, ScoreInfo,
} from "./types";
import { countFilled, siteIssues } from "./lib/lookups";
import ScheduleGrid from "./components/ScheduleGrid";
import FlagsPanel from "./components/FlagsPanel";
import Editor from "./components/Editor";

type View = "schedule" | "editor";

function emptyAssignments(ds: Dataset | null): Assignments {
  const a: Assignments = {};
  if (ds) for (const s of ds.seats) a[s.id] = null;
  return a;
}

export default function App() {
  const [req, setReq] = useState<RequirementsDoc | null>(null);
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [assignments, setAssignments] = useState<Assignments>({});
  const [score, setScore] = useState<ScoreInfo | null>(null);
  const [flags, setFlags] = useState<Flag[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [view, setView] = useState<View>("schedule");
  const [solving, setSolving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [siteId, setSiteId] = useState<string>("");
  const [fatal, setFatal] = useState<string | null>(null);
  // Carry-over (ADR-0002): `carryover` is the seed currently applied to this week;
  // `nextCarryover` is the seed the latest solve/validate produced for the NEXT week.
  const [carryover, setCarryover] = useState<CarryoverSeed | null>(null);
  const [nextCarryover, setNextCarryover] = useState<CarryoverSeed | null>(null);
  const reqToken = useRef(0);
  const buildToken = useRef(0);

  // load the seed requirements once
  useEffect(() => {
    getRequirements().then(setReq).catch((e) => setFatal(String(e)));
  }, []);

  // rebuild (materialise) whenever the requirements change — debounced.
  // Editing the org invalidates any existing solution, so the schedule resets.
  useEffect(() => {
    if (!req) return;
    // Invalidate the stale next-week seed IMMEDIATELY (not after the debounce), so
    // the "Carry to next week" button can't be clicked during the rebuild window.
    setNextCarryover(null);
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
    setReq(next);
  }, []);

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

  if (fatal && !req) return <div className="fatal" role="alert">Failed to load: {fatal}</div>;
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
            </button>
          </div>
          <ScoreBadge score={score} filled={filled} total={total} />
          <button className="btn btn--primary" data-testid="solve-button" onClick={handleSolve}
            disabled={solving || blocked} title={blocked ? "Fix requirement errors first" : ""}>
            {solving ? "Solving…" : score ? "Re-solve" : "Generate schedule"}
          </button>
          {nextCarryover?.target_week_start && (
            <button className="btn" data-testid="carry-button" onClick={handleCarryForward}
              disabled={solving || validating || blocked}
              title={`Seed the week of ${fmt(nextCarryover.target_week_start)} from this schedule`}>
              Carry to {fmt(nextCarryover.target_week_start)} →
            </button>
          )}
        </div>
      </header>

      {view === "editor" ? (
        <main className="editorwrap">
          <Editor req={req} onChange={handleRequirementsChange} errors={errors} warnings={warnings} />
        </main>
      ) : (
        <>
          {dataset && (
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
              {dataset && <ScheduleGrid ds={dataset} teams={teams} assignments={assignments} onChange={handleChange} />}
            </div>
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
