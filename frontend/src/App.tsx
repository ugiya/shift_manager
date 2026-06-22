import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { build as apiBuild, getRequirements, solve as apiSolve, validate as apiValidate } from "./api";
import type { Assignments, Dataset, Flag, RequirementsDoc, ScoreInfo } from "./types";
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
    const token = ++buildToken.current;
    const h = setTimeout(async () => {
      try {
        const r = await apiBuild(req);
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
  }, [req]);

  const handleSolve = useCallback(async () => {
    if (!req) return;
    setSolving(true);
    try {
      const r = await apiSolve(req);
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
      setView("schedule");
      if (!r.dataset.sites.some((s) => s.id === siteId)) setSiteId(r.dataset.sites[0]?.id ?? "");
    } catch (e) {
      setFatal(String(e));
    } finally {
      setSolving(false);
    }
  }, [req, siteId]);

  const handleChange = useCallback(
    async (seatId: string, employeeId: string | null) => {
      if (!req) return;
      const next = { ...assignments, [seatId]: employeeId };
      setAssignments(next);
      const token = ++reqToken.current;
      setValidating(true);
      try {
        const r = await apiValidate(req, next);
        if (token === reqToken.current && r.score) {
          setScore(r.score);
          setFlags(r.flags);
        }
      } catch (e) {
        setFatal(String(e));
      } finally {
        if (token === reqToken.current) setValidating(false);
      }
    },
    [req, assignments],
  );

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
        </div>
      </header>

      {view === "editor" ? (
        <main className="editorwrap">
          <Editor req={req} onChange={setReq} errors={errors} warnings={warnings} />
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
      data-soft={score.soft_score}>
      <span className="badge__dot" aria-hidden />
      {score.feasible ? "Feasible" : "Infeasible"}
      <span className="badge__sep">·</span>{filled}/{total} filled
      <span className="badge__sep">·</span>penalty {Math.abs(score.soft_score)}
    </span>
  );
}

function fmt(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
