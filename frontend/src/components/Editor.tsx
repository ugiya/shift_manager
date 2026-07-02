import { useEffect, useState } from "react";
import type { CarryoverSeed, ReqEmployee, RequirementsDoc } from "../types";
import { DAY_NAMES } from "../types";
import { useI18n } from "../lib/i18n";
import ImportExport from "./ImportExport";
import {
  deleteProject,
  deleteRole,
  deleteShiftType,
  deleteSite,
  deleteTeam,
  nextId,
  projectsForTeam,
  pruneCrew,
  runsThisWeek,
} from "../lib/req";

interface Props {
  // Round 2 #1: the editor edits a LOCAL draft. Field edits call `onDraftChange` (no
  // rebuild); the schedule only re-materialises when the user clicks Save (`onSave`).
  // `onCommit` replaces+commits a whole doc (used by import). `onDiscard` reverts the draft.
  draft: RequirementsDoc;
  onDraftChange: (next: RequirementsDoc) => void;
  onCommit: (next: RequirementsDoc) => void;
  onSave: () => void;
  onDiscard: () => void;
  dirty: boolean;
  errors: string[];
  warnings: string[];
  // The active carry-over seed (ADR-0002), if any. For employees it covers, the carry-over
  // fields are disabled AND display the SEED's values — `apply_carryover_seed` overwrites the
  // document's fields with these on every build/solve/validate, so showing the document's own
  // (pre-seed) values would present numbers the solve doesn't use.
  carryoverSeed?: CarryoverSeed | null;
  // Discard the autosaved session and reload the pristine seed document from the server.
  onResetToSeed: () => void;
}

// 2026-07-02 layout: the editor is tabbed — org structure, the employee roster
// (team-filterable, for a team lead), and the weekly demand (project-filterable, for a
// project lead, including the per-week "working this week" ticks). One draft/Save bar
// and one issues panel span all three: the document is still edited as a whole.
type EditorTab = "org" | "employees" | "demand";
const EDITOR_TABS: { id: EditorTab; labelKey: "tabOrg" | "tabEmployees" | "tabDemand" }[] = [
  { id: "org", labelKey: "tabOrg" },
  { id: "employees", labelKey: "tabEmployees" },
  { id: "demand", labelKey: "tabDemand" },
];

const ids = <T extends { id: string }>(xs: T[]) => xs.map((x) => x.id);
const upd = <T extends { id: string }>(xs: T[], id: string, patch: Partial<T>) =>
  xs.map((x) => (x.id === id ? { ...x, ...patch } : x));

export default function Editor({
  draft, onDraftChange, onCommit, onSave, onDiscard, dirty, errors, warnings, carryoverSeed,
  onResetToSeed,
}: Props) {
  const { t, weekdayNames } = useI18n();
  const req = draft;                                   // render & mutate the draft, not the committed doc
  const set = (part: Partial<RequirementsDoc>) => onDraftChange({ ...req, ...part });
  const [tab, setTab] = useState<EditorTab>("org");
  const [teamFilter, setTeamFilter] = useState("");        // "" = all teams
  const [projectFilter, setProjectFilter] = useState(""); // "" = all projects
  // First (team, shift_type) pair with no demand row yet — "+ Add" uses it so a new row is
  // never an instant overlapping duplicate (same-pair rows are legal only with disjoint
  // days; a fresh row defaults to Sun, which would overlap an existing same-pair row).
  // undefined ⇒ every pair already has a row, so Add is disabled — per-day crew variation
  // for a taken pair is still reachable by editing a row's team/shift-type/days directly.
  const takenDemand = new Set(req.demand.map((d) => `${d.team}|${d.shift_type}`));
  const freeDemandPair = req.teams
    .flatMap((t) => req.shift_types.map((st) => ({ team: t.id, shift_type: st.id })))
    .find((p) => !takenDemand.has(`${p.team}|${p.shift_type}`));

  const visibleEmployees = req.employees.filter((e) => !teamFilter || e.team === teamFilter);
  const filterProject = projectFilter ? req.projects.find((p) => p.id === projectFilter) : undefined;
  // A demand row is "about" a project when it already carries its crew, or when its team
  // is one the project runs in (so a project lead can ADD crew there). A row with a
  // pending team ("Please choose") stays visible only if it carries the project's crew.
  const visibleDemand = req.demand
    .map((d, idx) => ({ d, idx }))
    .filter(({ d }) => !filterProject
      || filterProject.id in d.crew
      || (d.team != null && filterProject.teams.includes(d.team)));

  return (
    <div className="editor" data-testid="editor">
      <div className="esave" data-testid="editor-savebar">
        <span className={`esave__status${dirty ? " is-dirty" : ""}`} data-testid="editor-dirty"
          data-dirty={dirty}>
          {dirty ? t("unsavedBanner") : t("allSaved")}
        </span>
        <span className="esave__spacer" />
        <button className="btn btn--sm" data-testid="editor-discard" disabled={!dirty}
          onClick={onDiscard} title={t("discardTitle")}>{t("discard")}</button>
        <button className="btn btn--sm btn--primary" data-testid="editor-save" disabled={!dirty}
          onClick={onSave} title={t("saveTitle")}>{t("saveChanges")}</button>
      </div>
      <div className="iorow">
        <ImportExport req={req} onChange={onCommit} />
        <ResetToSeed onReset={onResetToSeed} />
      </div>
      {(errors.length > 0 || warnings.length > 0) && (
        <div className="issues">
          {errors.length > 0 && (
            <div className="issues__box issues__box--err" data-testid="editor-errors">
              <strong>{t("errorsHdr", { n: errors.length })}</strong>
              <ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}
          {warnings.length > 0 && (
            <div className="issues__box issues__box--warn" data-testid="editor-warnings">
              <strong>{t("warningsHdr", { n: warnings.length })}</strong>
              <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      <nav className="edtabs" data-testid="editor-tabs" role="tablist">
        {EDITOR_TABS.map((et) => (
          <button key={et.id} role="tab" aria-selected={tab === et.id}
            className={`edtab${tab === et.id ? " is-active" : ""}`}
            data-testid={`editor-tab-${et.id}`} data-active={tab === et.id}
            onClick={() => setTab(et.id)}>
            {t(et.labelKey)}
          </button>
        ))}
      </nav>

      {tab === "org" && (
        <>
          {/* Sites */}
          <Section title={t("secSites")} testid="add-site"
            onAdd={() => set({ sites: [...req.sites, { id: nextId("site", ids(req.sites)), name: "New site" }] })}>
            {req.sites.map((s) => (
              <Row key={s.id} entity="site" id={s.id}
                onDelete={() => onDraftChange(deleteSite(req, s.id))}>
                <input className="in in--name" data-testid="name-input" value={s.name}
                  onChange={(e) => set({ sites: upd(req.sites, s.id, { name: e.target.value }) })} />
              </Row>
            ))}
          </Section>

          {/* Roles */}
          <Section title={t("secRoles")} testid="add-role"
            onAdd={() => set({ roles: [...req.roles, { id: nextId("role", ids(req.roles)), name: "New role" }] })}>
            {req.roles.map((r) => (
              <Row key={r.id} entity="role" id={r.id}
                onDelete={() => onDraftChange(deleteRole(req, r.id))}>
                <input className="in in--name" data-testid="name-input" value={r.name}
                  onChange={(e) => set({ roles: upd(req.roles, r.id, { name: e.target.value }) })} />
              </Row>
            ))}
          </Section>

          {/* Shift types */}
          <Section title={t("secShiftTypes")} testid="add-shifttype"
            onAdd={() => set({ shift_types: [...req.shift_types, { id: nextId("st", ids(req.shift_types)), name: "New shift", start: 8, end: 16, is_night: false }] })}>
            {req.shift_types.map((st) => (
              <Row key={st.id} entity="shifttype" id={st.id}
                onDelete={() => onDraftChange(deleteShiftType(req, st.id))}>
                <input className="in in--name" data-testid="name-input" value={st.name}
                  onChange={(e) => set({ shift_types: upd(req.shift_types, st.id, { name: e.target.value }) })} />
                <label className="hours">{t("hoursStart")}
                  <input className="in in--num" type="number" min={0} max={23} value={st.start}
                    onChange={(e) => set({ shift_types: upd(req.shift_types, st.id, { start: clampHour(e.target.value) }) })} />
                </label>
                <label className="hours">{t("hoursEnd")}
                  <input className="in in--num" type="number" min={0} max={23} value={st.end}
                    onChange={(e) => set({ shift_types: upd(req.shift_types, st.id, { end: clampHour(e.target.value) }) })} />
                </label>
                <label className="chk"><input type="checkbox" checked={st.is_night}
                  onChange={(e) => set({ shift_types: upd(req.shift_types, st.id, { is_night: e.target.checked }) })} /> {t("night")}</label>
              </Row>
            ))}
          </Section>

          {/* Teams */}
          <Section title={t("secTeams")} testid="add-team"
            addDisabled={req.sites.length === 0} addTitle={req.sites.length === 0 ? t("addSiteFirst") : undefined}
            onAdd={() => req.sites[0] && set({ teams: [...req.teams, { id: nextId("team", ids(req.teams)), name: "New team", site: req.sites[0].id }] })}>
            {req.teams.map((tm) => (
              <Row key={tm.id} entity="team" id={tm.id}
                onDelete={() => onDraftChange(deleteTeam(req, tm.id))}>
                <input className="in in--name" data-testid="name-input" value={tm.name}
                  onChange={(e) => set({ teams: upd(req.teams, tm.id, { name: e.target.value }) })} />
                <PickSelect testid="team-site" value={tm.site} placeholder={t("pleaseChoose")}
                  options={req.sites}
                  onPick={(site) => set({ teams: upd(req.teams, tm.id, { site }) })} />
              </Row>
            ))}
          </Section>

          {/* Projects (org structure; the per-week tick lives in Project Requirements) */}
          <Section title={t("secProjects")} testid="add-project"
            addDisabled={req.teams.length === 0} addTitle={req.teams.length === 0 ? t("addTeamFirst") : undefined}
            onAdd={() => req.teams[0] && set({ projects: [...req.projects, { id: nextId("proj", ids(req.projects)), name: "New project", teams: [req.teams[0].id], runs_this_week: true }] })}>
            {req.projects.map((p) => (
              <Row key={p.id} entity="project" id={p.id}
                onDelete={() => onDraftChange(deleteProject(req, p.id))}>
                <input className="in in--name" data-testid="name-input" value={p.name}
                  onChange={(e) => set({ projects: upd(req.projects, p.id, { name: e.target.value }) })} />
                <div className="multi" data-testid="project-teams">
                  {req.teams.map((tm) => (
                    <label key={tm.id} className="chk">
                      <input type="checkbox" data-testid="project-team-option" data-team-id={tm.id}
                        checked={p.teams.includes(tm.id)}
                        onChange={(ev) => set({ projects: upd(req.projects, p.id, {
                          teams: ev.target.checked ? [...p.teams, tm.id] : p.teams.filter((x) => x !== tm.id),
                        }) })} /> {tm.name}
                    </label>
                  ))}
                </div>
              </Row>
            ))}
          </Section>
        </>
      )}

      {tab === "employees" && (
        <>
          <div className="efilter">
            <label className="chk">{t("filterTeam")}{" "}
              <select className="in" data-testid="employee-team-filter" value={teamFilter}
                onChange={(e) => setTeamFilter(e.target.value)}>
                <option value="">{t("allTeams")}</option>
                {req.teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
              </select>
            </label>
          </div>

          {/* Employees */}
          <Section title={t("secEmployees")} testid="add-employee"
            addDisabled={req.teams.length === 0} addTitle={req.teams.length === 0 ? t("addTeamFirst") : undefined}
            onAdd={() => req.teams[0] && set({ employees: [...req.employees, {
              id: nextId("emp", ids(req.employees)), name: "New person",
              team: teamFilter || req.teams[0].id,
              roles: [], projects: [], can_manage: false,
              status: "active", employee_number: null, email: null, phone: null, hire_date: null, notes: null,
              carryover_burden: 0, worked_last_weekend: false,
              prev_shift_end: null, prev_shift_was_night: false, avoid_shift_ids: [], unavailable_dates: [],
              preferred_shift_type_ids: [] }] })}>
            {visibleEmployees.map((e) => {
              // Only projects running this week appear here — the per-week tick hides a
              // paused project from the roster (membership itself is kept in the doc).
              const teamProjects = projectsForTeam(req, e.team).filter(runsThisWeek);
              // When a seed governs this employee, show ITS values — they're what the solve
              // actually uses (the seed overwrites the document's fields on every build).
              const sv = carryoverSeed?.employees?.[e.id];
              const seeded = sv != null;
              const seededTitle = seeded ? t("seededFieldTitle") : undefined;
              const toggle = (key: "roles" | "projects", id: string) => {
                const has = e[key].includes(id);
                const list = has ? e[key].filter((x) => x !== id) : [...e[key], id];
                const patch: Partial<ReqEmployee> = key === "roles" ? { roles: list } : { projects: list };
                set({ employees: upd(req.employees, e.id, patch) });
              };
              return (
                <Row key={e.id} entity="employee" id={e.id}
                  onDelete={() => set({ employees: req.employees.filter((x) => x.id !== e.id) })}>
                  <input className="in in--name" data-testid="name-input" value={e.name}
                    onChange={(ev) => set({ employees: upd(req.employees, e.id, { name: ev.target.value }) })} />
                  <PickSelect testid="employee-team" value={e.team} placeholder={t("pleaseChoose")}
                    options={req.teams}
                    onPick={(team) => {
                      // Keep memberships in projects that also run in the new team (ADR-0003:
                      // projects may span teams) — only drop the ones that genuinely don't.
                      const valid = new Set(projectsForTeam(req, team).map((p) => p.id));
                      set({ employees: upd(req.employees, e.id,
                        { team, projects: e.projects.filter((pid) => valid.has(pid)) }) });
                    }} />
                  <select className="in" data-testid="employee-status" value={e.status}
                    title={t("statusTitle")}
                    onChange={(ev) => set({ employees: upd(req.employees, e.id, { status: ev.target.value }) })}>
                    {["active", "on-leave", "inactive"].map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <Chips label="roles" display={t("chipsRoles")} all={req.roles} selected={e.roles} onToggle={(id) => toggle("roles", id)} />
                  <Chips label="projects" display={t("chipsProjects")} all={teamProjects} selected={e.projects} onToggle={(id) => toggle("projects", id)} />
                  <Chips label="prefers" display={t("chipsPrefers")} all={req.shift_types} selected={e.preferred_shift_type_ids}
                    onToggle={(id) => set({ employees: upd(req.employees, e.id, {
                      preferred_shift_type_ids: e.preferred_shift_type_ids.includes(id)
                        ? e.preferred_shift_type_ids.filter((x) => x !== id)
                        : [...e.preferred_shift_type_ids, id] }) })} />
                  <label className="chk" data-testid="employee-canmanage">
                    <input type="checkbox" checked={e.can_manage}
                      onChange={(ev) => set({ employees: upd(req.employees, e.id, { can_manage: ev.target.checked }) })} /> {t("canManage")}
                  </label>
                  <label className="hours" title={seededTitle}>{t("carry")}
                    <input className="in in--num" type="number" min={0} disabled={seeded}
                      value={sv ? sv.carryover_burden : e.carryover_burden}
                      onChange={(ev) => set({ employees: upd(req.employees, e.id, { carryover_burden: Math.max(0, parseInt(ev.target.value || "0", 10)) }) })} />
                  </label>
                  <label className="chk" title={seededTitle}><input type="checkbox" disabled={seeded}
                    checked={sv ? sv.worked_last_weekend : e.worked_last_weekend}
                    onChange={(ev) => set({ employees: upd(req.employees, e.id, { worked_last_weekend: ev.target.checked }) })} /> {t("workedLastWknd")}</label>
                  <label className="hours" title={seededTitle ?? t("prevEndTitle")}>{t("prevEnd")}
                    <input className="in" type="datetime-local" data-testid="employee-prevend" disabled={seeded}
                      value={(sv ? sv.prev_shift_end : e.prev_shift_end)?.slice(0, 16) ?? ""}
                      onChange={(ev) => set({ employees: upd(req.employees, e.id, { prev_shift_end: ev.target.value || null }) })} />
                  </label>
                  <label className="chk" title={seededTitle}><input type="checkbox" disabled={seeded}
                    checked={sv ? sv.prev_shift_was_night : e.prev_shift_was_night}
                    onChange={(ev) => set({ employees: upd(req.employees, e.id, { prev_shift_was_night: ev.target.checked }) })} /> {t("prevNight")}</label>
                  <UnavailableDates dates={e.unavailable_dates}
                    onChange={(dates) => set({ employees: upd(req.employees, e.id, { unavailable_dates: dates }) })} />
                </Row>
              );
            })}
          </Section>
        </>
      )}

      {tab === "demand" && (
        <>
          <div className="efilter">
            <label className="chk">{t("filterProject")}{" "}
              <select className="in" data-testid="project-filter" value={projectFilter}
                onChange={(e) => setProjectFilter(e.target.value)}>
                <option value="">{t("allProjects")}</option>
                {req.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </label>
          </div>

          {/* Per-week ticks: which projects are relevant THIS week. Unticking never
              deletes anything — the project's crew simply doesn't materialise. */}
          <section className="esec">
            <div className="esec__head"><h3 title={t("thisWeekTitle")}>{t("thisWeek")}</h3></div>
            <div className="esec__body esec__body--wrap">
              {req.projects
                .filter((p) => !projectFilter || p.id === projectFilter)
                .map((p) => (
                  <label key={p.id} className={`chk weektick${runsThisWeek(p) ? "" : " is-off"}`}
                    title={t("thisWeekTitle")}>
                    <input type="checkbox" data-testid="project-thisweek" data-project-id={p.id}
                      checked={runsThisWeek(p)}
                      onChange={(ev) => set({ projects: upd(req.projects, p.id, { runs_this_week: ev.target.checked }) })} />
                    {" "}{p.name}
                    {!runsThisWeek(p) && <span className="chips__none">&nbsp;({t("notThisWeek")})</span>}
                  </label>
                ))}
            </div>
          </section>

          {/* Demand */}
          <Section title={t("secDemand")} testid="add-demand"
            addDisabled={!freeDemandPair}
            addTitle={freeDemandPair ? undefined : t("demandPairTaken")}
            onAdd={() => freeDemandPair && set({ demand: [...req.demand, {
              team: freeDemandPair.team, shift_type: freeDemandPair.shift_type, days: ["Sun"], crew: {} }] })}>
            {visibleDemand.map(({ d, idx }) => {
              const setD = (patch: Partial<typeof d>) =>
                set({ demand: req.demand.map((x, i) => (i === idx ? { ...x, ...patch } : x)) });
              // The filter narrows the crew a project lead sees to their own project.
              const teamProjects = projectsForTeam(req, d.team)
                .filter((p) => !projectFilter || p.id === projectFilter);
              const setCount = (pid: string, rid: string, n: number) => {
                const crew = JSON.parse(JSON.stringify(d.crew)) as typeof d.crew;
                if (n <= 0) { if (crew[pid]) { delete crew[pid][rid]; if (!Object.keys(crew[pid]).length) delete crew[pid]; } }
                else { crew[pid] = crew[pid] || {}; crew[pid][rid] = n; }
                setD({ crew });
              };
              return (
                <div className="demand-row" data-testid="demand-row" data-index={idx} key={idx}>
                  <div className="demand-row__head">
                    <PickSelect testid="demand-team" value={d.team} placeholder={t("pleaseChoose")}
                      options={req.teams}
                      onPick={(team) => setD({ team, crew: pruneCrew(req, team, d.crew) })} />
                    <PickSelect testid="demand-shifttype" value={d.shift_type} placeholder={t("pleaseChoose")}
                      options={req.shift_types}
                      onPick={(shift_type) => setD({ shift_type })} />
                    <div className="days">
                      {DAY_NAMES.map((day) => (
                        <button key={day} type="button"
                          className={`daybtn${d.days.includes(day) ? " is-on" : ""}`}
                          data-testid="day-toggle" data-day={day}
                          onClick={() => setD({ days: d.days.includes(day) ? d.days.filter((x) => x !== day) : [...d.days, day] })}>
                          {/* values stay the doc's English day tokens; only the display translates */}
                          {weekdayNames ? weekdayNames[(DAY_NAMES.indexOf(day) + 6) % 7] : day}
                        </button>
                      ))}
                    </div>
                    <button className="btn btn--danger btn--sm" data-testid="delete-demand"
                      onClick={() => set({ demand: req.demand.filter((_, i) => i !== idx) })}>{t("delete")}</button>
                  </div>
                  <div className="crew">
                    {teamProjects.length === 0 && <span className="crew__empty">{t("teamNoProjects")}</span>}
                    {teamProjects.map((p) => (
                      <div className={`crew__proj${runsThisWeek(p) ? "" : " is-off"}`} key={p.id}>
                        <span className="crew__projname">{p.name}
                          {!runsThisWeek(p) && <span className="chips__none">&nbsp;({t("notThisWeek")})</span>}
                        </span>
                        {req.roles.map((r) => (
                          <label className="crew__role" key={r.id}>
                            {r.name}
                            <input className="in in--num" type="number" min={0}
                              data-testid={`crew-${p.id}-${r.id}`}
                              value={d.crew[p.id]?.[r.id] ?? 0}
                              onChange={(e) => setCount(p.id, r.id, Math.max(0, parseInt(e.target.value || "0", 10)))} />
                          </label>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </Section>
        </>
      )}
    </div>
  );
}

// Destructive, so it uses a two-step inline confirm (an armed state that expires) rather
// than a browser dialog — dialogs block automation and are easy to click through blind.
function ResetToSeed({ onReset }: { onReset: () => void }) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const h = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(h);
  }, [armed]);
  if (!armed) {
    return (
      <button className="btn btn--sm" data-testid="reset-seed" onClick={() => setArmed(true)}
        title={t("resetSeedTitle")}>
        {t("resetSeed")}
      </button>
    );
  }
  return (
    <span className="resetconfirm" role="alertdialog" aria-label="Confirm reset">
      <span className="resetconfirm__msg">{t("resetConfirmMsg")}</span>
      <button className="btn btn--sm btn--danger" data-testid="reset-seed-confirm"
        onClick={() => { setArmed(false); onReset(); }}>{t("yesReset")}</button>
      <button className="btn btn--sm" data-testid="reset-seed-cancel"
        onClick={() => setArmed(false)}>{t("cancel")}</button>
    </span>
  );
}

function clampHour(v: string): number {
  const n = parseInt(v || "0", 10);
  return Math.min(23, Math.max(0, isNaN(n) ? 0 : n));
}

// A reference select that can be PENDING (null after its target was deleted): shows a
// disabled "Please choose…" placeholder and a warning border until the user re-picks.
function PickSelect({ testid, value, placeholder, options, onPick }: {
  testid: string; value: string | null; placeholder: string;
  options: { id: string; name: string }[]; onPick: (id: string) => void;
}) {
  return (
    <select className={`in${value == null ? " in--pending" : ""}`} data-testid={testid}
      value={value ?? ""} onChange={(e) => e.target.value && onPick(e.target.value)}>
      {value == null && <option value="" disabled>{placeholder}</option>}
      {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
}

function Section({ title, testid, onAdd, children, addDisabled = false, addTitle }: {
  title: string; testid: string; onAdd: () => void; children: React.ReactNode;
  addDisabled?: boolean; addTitle?: string;
}) {
  const { t } = useI18n();
  return (
    <section className="esec">
      <div className="esec__head">
        <h3>{title}</h3>
        <button className="btn btn--sm" data-testid={testid} onClick={onAdd}
          disabled={addDisabled} title={addTitle}>{t("add")}</button>
      </div>
      <div className="esec__body">{children}</div>
    </section>
  );
}

// Delete is ALWAYS enabled (2026-07-02): removing an entity nulls the references to it
// ("Please choose") instead of blocking or cascading — see lib/req.ts delete helpers.
function Row({ entity, id, onDelete, children }: {
  entity: string; id: string; onDelete: () => void; children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="erow" data-testid={`${entity}-row`} data-id={id}>
      <div className="erow__fields">{children}</div>
      <button className="btn btn--danger btn--sm" data-testid={`delete-${entity}`}
        title={t("delete")} onClick={onDelete}>{t("delete")}</button>
    </div>
  );
}

// Phase 3: an employee's Unavailability — ISO dates they can't work. Each date is
// removed from the eligibility of seats whose shift starts that day (worker + manager).
function UnavailableDates({ dates, onChange }: {
  dates: string[]; onChange: (dates: string[]) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="chips" data-testid="employee-unavailable" title={t("unavailTitle")}>
      <span className="chips__label">{t("offLabel")}</span>
      {dates.length === 0 && <span className="chips__none">{t("none")}</span>}
      {dates.map((d) => (
        <button key={d} type="button" className="chip is-on" data-testid="unavail-date" data-date={d}
          title={t("remove")} onClick={() => onChange(dates.filter((x) => x !== d))}>
          {d} ×
        </button>
      ))}
      <input className="in in--num" type="date" data-testid="unavail-add"
        onChange={(ev) => {
          const v = ev.target.value;
          if (v && !dates.includes(v)) onChange([...dates, v].sort());
          ev.target.value = "";
        }} />
    </div>
  );
}

// `label` is the stable id (drives the testid); `display` is the translated caption.
function Chips({ label, display, all, selected, onToggle }: {
  label: string; display?: string; all: { id: string; name: string }[]; selected: string[];
  onToggle: (id: string) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="chips" data-testid={`chips-${label}`}>
      <span className="chips__label">{display ?? label}:</span>
      {all.length === 0 && <span className="chips__none">{t("none")}</span>}
      {all.map((x) => (
        <button key={x.id} type="button"
          className={`chip${selected.includes(x.id) ? " is-on" : ""}`}
          data-chip={x.id} onClick={() => onToggle(x.id)}>
          {x.name}
        </button>
      ))}
    </div>
  );
}
