import { useMemo, useState } from "react";
import type { Assignments, Dataset, RequirementsDoc, Seat } from "../types";
import { DAY_NAMES } from "../types";
import { dayHeader } from "../lib/lookups";
import { fmtFull } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { runsThisWeek, setCrewCount, setDemandDays } from "../lib/req";
import SeatCell from "./SeatCell";

// Phase 6 + Round 2 #2/#4: seat-centric view grouped by PROJECT, now EDITABLE in two ways
// that honour the project's design split:
//  - Requirements (counts per team·shift-type·role, and which DAYS the shift runs) edit the
//    DRAFT demand → they only take effect on Save (a project-view save bar appears while
//    dirty). Structure is driven by the draft, so a new requirement shows at once.
//  - Assignments (who fills each materialised seat) are immediate, via the shared SeatCell —
//    the same contract as the Site grid. Seats come from the committed dataset, so newly
//    added requirements show seats only after Save (the save bar says so).
// A project may run across teams/sites (ADR-0003); its shift-groups aggregate across them.

interface Props {
  ds: Dataset;
  assignments: Assignments;
  draft: RequirementsDoc;
  onDraftChange: (next: RequirementsDoc) => void;
  onSave: () => void;
  onDiscard: () => void;
  dirty: boolean;
  building: boolean;
  solving: boolean;
  onChange: (seatId: string, employeeId: string | null) => void;  // assignment (immediate)
}

// `idx` = the demand-row index in the DRAFT. A (team, shift_type) pair may span several
// rows with disjoint days (per-day crew variation), so edits address the row by index —
// the pair alone would always hit the first row.
interface Group { idx: number; team: string; shiftType: string; days: string[]; roles: string[] }

export default function ProjectView({ ds, assignments, draft, onDraftChange, onSave, onDiscard, dirty, building, solving, onChange }: Props) {
  const { t, lang, weekdayNames } = useI18n();
  // Seats are read-only while there are unsaved requirement edits or a rebuild is in flight
  // (the next Save rebuilds the schedule and clears assignments, so editing one now would be
  // lost) — and while a solve runs, so an edit can't silently supersede and discard it.
  const seatsLocked = dirty || building || solving;
  const teamName = useMemo(() => new Map(draft.teams.map((t) => [t.id, t.name])), [draft]);
  const roleName = useMemo(() => new Map(draft.roles.map((r) => [r.id, r.name])), [draft]);
  const stName = useMemo(() => new Map(draft.shift_types.map((s) => [s.id, s.name])), [draft]);
  const empName = useMemo(() => new Map(ds.employees.map((e) => [e.id, e.name])), [ds]);
  const shiftById = useMemo(() => new Map(ds.shifts.map((s) => [s.id, s])), [ds]);

  // Committed worker seats for a project, indexed by (team|shiftType|role|date) for the cells.
  const seatsByLane = useMemo(() => {
    const m = new Map<string, Seat[]>();
    for (const seat of ds.seats) {
      if (seat.kind !== "worker" || !seat.project_id || !seat.role_id) continue;
      const sh = shiftById.get(seat.shift_id);
      if (!sh) continue;
      const key = `${seat.project_id}|${seat.team_id}|${sh.shift_type_id}|${seat.role_id}|${sh.date}`;
      const arr = m.get(key) ?? [];
      arr.push(seat);
      m.set(key, arr);
    }
    return m;
  }, [ds, shiftById]);

  // Per project, the shift-groups it has demand in — ONE GROUP PER DEMAND ROW, from the
  // DRAFT (so two disjoint-day rows for the same pair render as two editable groups).
  function groupsFor(projectId: string): Group[] {
    const groups: Group[] = [];
    draft.demand.forEach((d, idx) => {
      // A row with a deleted (pending "Please choose") team or shift type can't render a
      // lane — it materialises nothing until the reference is re-picked in the editor.
      if (d.team == null || d.shift_type == null) return;
      const roles = d.crew[projectId] ? Object.keys(d.crew[projectId]).filter((r) => d.crew[projectId][r] > 0) : [];
      if (roles.length === 0) return;
      groups.push({ idx, team: d.team, shiftType: d.shift_type, days: d.days, roles });
    });
    groups.sort((a, b) =>
      `${teamName.get(a.team)}|${stName.get(a.shiftType)}`.localeCompare(`${teamName.get(b.team)}|${stName.get(b.shiftType)}`)
      || a.idx - b.idx);
    return groups;
  }

  const draftCount = (g: Group, project: string, role: string): number =>
    draft.demand[g.idx]?.crew[project]?.[role] ?? 0;

  return (
    <div className="project-view" data-testid="project-view">
      {dirty && (
        <div className="esave" data-testid="project-savebar">
          <span className="esave__status is-dirty" data-testid="project-dirty">
            {t("unsavedReq")}
          </span>
          <span className="esave__spacer" />
          <button className="btn btn--sm" data-testid="project-discard" onClick={onDiscard}>{t("discard")}</button>
          <button className="btn btn--sm btn--primary" data-testid="project-save" onClick={onSave}>{t("saveChanges")}</button>
        </div>
      )}

      {draft.projects.map((project) => {
        const groups = groupsFor(project.id);
        const spansTeams = project.teams.length > 1;
        return (
          <section key={project.id} className="team" data-testid="project-section" data-project-id={project.id}>
            <h2 className="team__title">
              {project.name}
              {spansTeams && <span className="project__cross" data-testid="cross-site-tag">{" "}{t("crossTeam")}</span>}
              {!runsThisWeek(project) && (
                <span className="chips__none" data-testid="project-offweek">{" "}({t("notThisWeek")})</span>
              )}
            </h2>

            {groups.length === 0 && (
              <p className="project__empty" data-testid="project-empty">{t("noRequirements")}</p>
            )}

            {groups.map((g) => (
              <div key={`${g.idx}|${g.team}|${g.shiftType}`} className="pgroup" data-testid="project-group"
                data-team-id={g.team} data-st-id={g.shiftType}>
                <div className="grid-scroll">
                  <div className="grid" style={{ gridTemplateColumns: `var(--rowhdr) repeat(7, minmax(140px, 1fr))` }}>
                    {/* group header: label + per-day run toggles (edit the draft demand row's days) */}
                    <div className="grid__corner pgroup__label">{teamName.get(g.team) ?? g.team} · {stName.get(g.shiftType) ?? g.shiftType}</div>
                    {ds.days.map((d, i) => {
                      const h = dayHeader(d, ds.weekend_weekdays, weekdayNames, lang === "he" ? "he-IL" : undefined);
                      const dayName = DAY_NAMES[new Date(d + "T00:00:00").getDay()];
                      const on = g.days.includes(dayName);
                      return (
                        <div key={d} className={`grid__dayhdr${h.weekend ? " is-weekend" : ""}`}
                          title={fmtFull(d, lang)}>
                          <span className="grid__dayname">{h.name}</span>
                          <span className="grid__daydom">{h.dom}{(i === 0 || h.monthStart) ? ` ${h.mon}` : ""}</span>
                          <button type="button" className={`pday${on ? " is-on" : ""}`} data-testid="project-day-toggle"
                            data-day={dayName} data-on={on} title={on ? t("runsThisDay") : t("offThisDay")}
                            onClick={() => onDraftChange(setDemandDays(draft, g.team, g.shiftType,
                              on ? g.days.filter((x) => x !== dayName) : [...g.days, dayName], g.idx))}>
                            {on ? t("on") : t("off")}
                          </button>
                        </div>
                      );
                    })}

                    {/* one row per role: a count stepper + the materialised seats per day */}
                    {g.roles.map((role) => {
                      const n = draftCount(g, project.id, role);
                      return (
                        <div key={role} style={{ display: "contents" }} data-testid="project-lane" data-role-id={role}>
                          <div className="grid__rowhdr pgroup__rolehdr">
                            <span className="pgroup__rolename">{roleName.get(role) ?? role}</span>
                            <span className="stepper" data-testid="crew-stepper">
                              <button type="button" className="stepper__btn" data-testid="crew-dec"
                                aria-label={`one fewer ${roleName.get(role) ?? role}`}
                                onClick={() => onDraftChange(setCrewCount(draft, g.team, g.shiftType, project.id, role, n - 1, g.idx))}>−</button>
                              <span className="stepper__n" data-testid="crew-count">{n}</span>
                              <button type="button" className="stepper__btn" data-testid="crew-inc"
                                aria-label={`one more ${roleName.get(role) ?? role}`}
                                onClick={() => onDraftChange(setCrewCount(draft, g.team, g.shiftType, project.id, role, n + 1, g.idx))}>+</button>
                            </span>
                          </div>
                          {ds.days.map((d) => {
                            const dayName = DAY_NAMES[new Date(d + "T00:00:00").getDay()];
                            const weekend = dayHeader(d, ds.weekend_weekdays, weekdayNames).weekend;
                            if (!g.days.includes(dayName)) {
                              return <div key={d} className={`cell cell--empty${weekend ? " is-weekend" : ""}`} data-testid="project-cell">·</div>;
                            }
                            const seats = seatsByLane.get(`${project.id}|${g.team}|${g.shiftType}|${role}|${d}`) ?? [];
                            return (
                              <div key={d} className={`cell${weekend ? " is-weekend" : ""}`} data-testid="project-cell">
                                {seats.length === 0
                                  ? <span className="rocell__off" title={t("noSeatYet")}>—</span>
                                  : seats.map((s) => seatsLocked
                                      // While requirement edits are unsaved, the next Save rebuilds the schedule
                                      // (clearing assignments), so seats are read-only until then — assign after Save.
                                      ? <div key={s.id} className="roseat roseat--readonly" data-testid="project-seat-ro" data-seat-id={s.id}
                                          title={t("finishReqFirst")}>
                                          {assignments[s.id] ? (empName.get(assignments[s.id]!) ?? assignments[s.id]) : t("unfilledOpt")}
                                        </div>
                                      : <SeatCell key={s.id} seat={s} ds={ds} assignedId={assignments[s.id] ?? null} onChange={onChange} />
                                    )}
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            ))}

            <AddRequirement project={project.id} teams={project.teams} draft={draft}
              teamName={teamName} stName={stName} roleName={roleName} onDraftChange={onDraftChange} />
          </section>
        );
      })}
    </div>
  );
}

// Add a new (team · shift-type · role) requirement to a project (count starts at 1, draft).
function AddRequirement({ project, teams, draft, teamName, stName, roleName, onDraftChange }: {
  project: string; teams: string[]; draft: RequirementsDoc;
  teamName: Map<string, string>; stName: Map<string, string>; roleName: Map<string, string>;
  onDraftChange: (next: RequirementsDoc) => void;
}) {
  const { t } = useI18n();
  const [team, setTeam] = useState(teams[0] ?? "");
  const [st, setSt] = useState(draft.shift_types[0]?.id ?? "");
  const [role, setRole] = useState(draft.roles[0]?.id ?? "");
  const teamChoices = teams.length ? teams : draft.teams.map((x) => x.id);
  const valid = team && st && role;
  return (
    <div className="addreq" data-testid="project-add-req">
      <span className="addreq__label">{t("addRequirement")}</span>
      <select className="in" data-testid="addreq-team" value={team} onChange={(e) => setTeam(e.target.value)}>
        {teamChoices.map((t) => <option key={t} value={t}>{teamName.get(t) ?? t}</option>)}
      </select>
      <select className="in" data-testid="addreq-st" value={st} onChange={(e) => setSt(e.target.value)}>
        {draft.shift_types.map((s) => <option key={s.id} value={s.id}>{stName.get(s.id) ?? s.id}</option>)}
      </select>
      <select className="in" data-testid="addreq-role" value={role} onChange={(e) => setRole(e.target.value)}>
        {draft.roles.map((r) => <option key={r.id} value={r.id}>{roleName.get(r.id) ?? r.id}</option>)}
      </select>
      <button className="btn btn--sm" data-testid="addreq-add" disabled={!valid}
        onClick={() => valid && onDraftChange(setCrewCount(draft, team, st, project, role,
          (draft.demand.find((d) => d.team === team && d.shift_type === st)?.crew[project]?.[role] ?? 0) + 1))}>
        {t("add")}
      </button>
    </div>
  );
}
