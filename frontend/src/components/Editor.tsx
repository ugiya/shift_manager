import type { RequirementsDoc } from "../types";
import { DAY_NAMES } from "../types";
import {
  nextId,
  projectsForTeam,
  projectReferenced,
  pruneCrew,
  roleReferenced,
  shiftTypeReferenced,
  siteReferenced,
  teamReferenced,
} from "../lib/req";

interface Props {
  req: RequirementsDoc;
  onChange: (next: RequirementsDoc) => void;
  errors: string[];
  warnings: string[];
}

const ids = <T extends { id: string }>(xs: T[]) => xs.map((x) => x.id);
const upd = <T extends { id: string }>(xs: T[], id: string, patch: Partial<T>) =>
  xs.map((x) => (x.id === id ? { ...x, ...patch } : x));
const rm = <T extends { id: string }>(xs: T[], id: string) => xs.filter((x) => x.id !== id);

export default function Editor({ req, onChange, errors, warnings }: Props) {
  const set = (part: Partial<RequirementsDoc>) => onChange({ ...req, ...part });

  return (
    <div className="editor" data-testid="editor">
      {(errors.length > 0 || warnings.length > 0) && (
        <div className="issues">
          {errors.length > 0 && (
            <div className="issues__box issues__box--err" data-testid="editor-errors">
              <strong>{errors.length} error(s) — fix to enable solving</strong>
              <ul>{errors.map((e, i) => <li key={i}>{e}</li>)}</ul>
            </div>
          )}
          {warnings.length > 0 && (
            <div className="issues__box issues__box--warn" data-testid="editor-warnings">
              <strong>{warnings.length} warning(s)</strong>
              <ul>{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
            </div>
          )}
        </div>
      )}

      {/* Sites */}
      <Section title="Sites" testid="add-site"
        onAdd={() => set({ sites: [...req.sites, { id: nextId("site", ids(req.sites)), name: "New site" }] })}>
        {req.sites.map((s) => (
          <Row key={s.id} entity="site" id={s.id}
            canDelete={!siteReferenced(req, s.id)}
            onDelete={() => set({ sites: rm(req.sites, s.id) })}>
            <input className="in in--name" data-testid="name-input" value={s.name}
              onChange={(e) => set({ sites: upd(req.sites, s.id, { name: e.target.value }) })} />
          </Row>
        ))}
      </Section>

      {/* Roles */}
      <Section title="Roles" testid="add-role"
        onAdd={() => set({ roles: [...req.roles, { id: nextId("role", ids(req.roles)), name: "New role" }] })}>
        {req.roles.map((r) => (
          <Row key={r.id} entity="role" id={r.id}
            canDelete={!roleReferenced(req, r.id)}
            onDelete={() => set({ roles: rm(req.roles, r.id) })}>
            <input className="in in--name" data-testid="name-input" value={r.name}
              onChange={(e) => set({ roles: upd(req.roles, r.id, { name: e.target.value }) })} />
          </Row>
        ))}
      </Section>

      {/* Shift types */}
      <Section title="Shift types" testid="add-shifttype"
        onAdd={() => set({ shift_types: [...req.shift_types, { id: nextId("st", ids(req.shift_types)), name: "New shift", start: 8, end: 16, is_night: false }] })}>
        {req.shift_types.map((st) => (
          <Row key={st.id} entity="shifttype" id={st.id}
            canDelete={!shiftTypeReferenced(req, st.id)}
            onDelete={() => set({ shift_types: rm(req.shift_types, st.id) })}>
            <input className="in in--name" data-testid="name-input" value={st.name}
              onChange={(e) => set({ shift_types: upd(req.shift_types, st.id, { name: e.target.value }) })} />
            <label className="hours">start
              <input className="in in--num" type="number" min={0} max={23} value={st.start}
                onChange={(e) => set({ shift_types: upd(req.shift_types, st.id, { start: clampHour(e.target.value) }) })} />
            </label>
            <label className="hours">end
              <input className="in in--num" type="number" min={0} max={23} value={st.end}
                onChange={(e) => set({ shift_types: upd(req.shift_types, st.id, { end: clampHour(e.target.value) }) })} />
            </label>
            <label className="chk"><input type="checkbox" checked={st.is_night}
              onChange={(e) => set({ shift_types: upd(req.shift_types, st.id, { is_night: e.target.checked }) })} /> night</label>
          </Row>
        ))}
      </Section>

      {/* Teams */}
      <Section title="Teams" testid="add-team"
        onAdd={() => req.sites[0] && set({ teams: [...req.teams, { id: nextId("team", ids(req.teams)), name: "New team", site: req.sites[0].id }] })}>
        {req.teams.map((t) => (
          <Row key={t.id} entity="team" id={t.id}
            canDelete={!teamReferenced(req, t.id)}
            onDelete={() => set({ teams: rm(req.teams, t.id) })}>
            <input className="in in--name" data-testid="name-input" value={t.name}
              onChange={(e) => set({ teams: upd(req.teams, t.id, { name: e.target.value }) })} />
            <select className="in" data-testid="team-site" value={t.site}
              onChange={(e) => set({ teams: upd(req.teams, t.id, { site: e.target.value }) })}>
              {req.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </Row>
        ))}
      </Section>

      {/* Projects */}
      <Section title="Projects" testid="add-project"
        onAdd={() => req.teams[0] && set({ projects: [...req.projects, { id: nextId("proj", ids(req.projects)), name: "New project", team: req.teams[0].id }] })}>
        {req.projects.map((p) => (
          <Row key={p.id} entity="project" id={p.id}
            canDelete={!projectReferenced(req, p.id)}
            onDelete={() => set({ projects: rm(req.projects, p.id) })}>
            <input className="in in--name" data-testid="name-input" value={p.name}
              onChange={(e) => set({ projects: upd(req.projects, p.id, { name: e.target.value }) })} />
            <select className="in" data-testid="project-team" value={p.team}
              onChange={(e) => set({ projects: upd(req.projects, p.id, { team: e.target.value }) })}>
              {req.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </Row>
        ))}
      </Section>

      {/* Employees */}
      <Section title="Employees" testid="add-employee"
        onAdd={() => req.teams[0] && set({ employees: [...req.employees, {
          id: nextId("emp", ids(req.employees)), name: "New person", team: req.teams[0].id,
          roles: [], projects: [], can_manage: false, carryover_burden: 0, worked_last_weekend: false }] })}>
        {req.employees.map((e) => {
          const teamProjects = projectsForTeam(req, e.team);
          const toggle = (key: "roles" | "projects", id: string) => {
            const has = e[key].includes(id);
            const list = has ? e[key].filter((x) => x !== id) : [...e[key], id];
            set({ employees: upd(req.employees, e.id, { [key]: list } as any) });
          };
          return (
            <Row key={e.id} entity="employee" id={e.id}
              canDelete onDelete={() => set({ employees: rm(req.employees, e.id) })}>
              <input className="in in--name" data-testid="name-input" value={e.name}
                onChange={(ev) => set({ employees: upd(req.employees, e.id, { name: ev.target.value }) })} />
              <select className="in" data-testid="employee-team" value={e.team}
                onChange={(ev) => set({ employees: upd(req.employees, e.id, { team: ev.target.value, projects: [] }) })}>
                {req.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <Chips label="roles" all={req.roles} selected={e.roles} onToggle={(id) => toggle("roles", id)} />
              <Chips label="projects" all={teamProjects} selected={e.projects} onToggle={(id) => toggle("projects", id)} />
              <label className="chk" data-testid="employee-canmanage">
                <input type="checkbox" checked={e.can_manage}
                  onChange={(ev) => set({ employees: upd(req.employees, e.id, { can_manage: ev.target.checked }) })} /> can manage
              </label>
              <label className="hours">carry
                <input className="in in--num" type="number" min={0} value={e.carryover_burden}
                  onChange={(ev) => set({ employees: upd(req.employees, e.id, { carryover_burden: Math.max(0, parseInt(ev.target.value || "0", 10)) }) })} />
              </label>
              <label className="chk"><input type="checkbox" checked={e.worked_last_weekend}
                onChange={(ev) => set({ employees: upd(req.employees, e.id, { worked_last_weekend: ev.target.checked }) })} /> worked last wknd</label>
            </Row>
          );
        })}
      </Section>

      {/* Demand */}
      <Section title="Demand" testid="add-demand"
        onAdd={() => req.teams[0] && req.shift_types[0] && set({ demand: [...req.demand, {
          team: req.teams[0].id, shift_type: req.shift_types[0].id, days: ["Sun"], crew: {} }] })}>
        {req.demand.map((d, idx) => {
          const setD = (patch: Partial<typeof d>) =>
            set({ demand: req.demand.map((x, i) => (i === idx ? { ...x, ...patch } : x)) });
          const teamProjects = projectsForTeam(req, d.team);
          const setCount = (pid: string, rid: string, n: number) => {
            const crew = JSON.parse(JSON.stringify(d.crew)) as typeof d.crew;
            if (n <= 0) { if (crew[pid]) { delete crew[pid][rid]; if (!Object.keys(crew[pid]).length) delete crew[pid]; } }
            else { crew[pid] = crew[pid] || {}; crew[pid][rid] = n; }
            setD({ crew });
          };
          return (
            <div className="demand-row" data-testid="demand-row" data-index={idx} key={idx}>
              <div className="demand-row__head">
                <select className="in" data-testid="demand-team" value={d.team}
                  onChange={(e) => setD({ team: e.target.value, crew: pruneCrew(req, e.target.value, d.crew) })}>
                  {req.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                <select className="in" data-testid="demand-shifttype" value={d.shift_type}
                  onChange={(e) => setD({ shift_type: e.target.value })}>
                  {req.shift_types.map((st) => <option key={st.id} value={st.id}>{st.name}</option>)}
                </select>
                <div className="days">
                  {DAY_NAMES.map((day) => (
                    <button key={day} type="button"
                      className={`daybtn${d.days.includes(day) ? " is-on" : ""}`}
                      data-testid="day-toggle" data-day={day}
                      onClick={() => setD({ days: d.days.includes(day) ? d.days.filter((x) => x !== day) : [...d.days, day] })}>
                      {day}
                    </button>
                  ))}
                </div>
                <button className="btn btn--danger btn--sm" data-testid="delete-demand"
                  onClick={() => set({ demand: req.demand.filter((_, i) => i !== idx) })}>Delete</button>
              </div>
              <div className="crew">
                {teamProjects.length === 0 && <span className="crew__empty">This team has no projects.</span>}
                {teamProjects.map((p) => (
                  <div className="crew__proj" key={p.id}>
                    <span className="crew__projname">{p.name}</span>
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
    </div>
  );
}

function clampHour(v: string): number {
  const n = parseInt(v || "0", 10);
  return Math.min(23, Math.max(0, isNaN(n) ? 0 : n));
}

function Section({ title, testid, onAdd, children }: {
  title: string; testid: string; onAdd: () => void; children: React.ReactNode;
}) {
  return (
    <section className="esec">
      <div className="esec__head">
        <h3>{title}</h3>
        <button className="btn btn--sm" data-testid={testid} onClick={onAdd}>+ Add</button>
      </div>
      <div className="esec__body">{children}</div>
    </section>
  );
}

function Row({ entity, id, canDelete, onDelete, children }: {
  entity: string; id: string; canDelete: boolean; onDelete: () => void; children: React.ReactNode;
}) {
  return (
    <div className="erow" data-testid={`${entity}-row`} data-id={id}>
      <div className="erow__fields">{children}</div>
      <button className="btn btn--danger btn--sm" data-testid={`delete-${entity}`}
        disabled={!canDelete} title={canDelete ? "Delete" : "In use — remove references first"}
        onClick={onDelete}>Delete</button>
    </div>
  );
}

function Chips({ label, all, selected, onToggle }: {
  label: string; all: { id: string; name: string }[]; selected: string[]; onToggle: (id: string) => void;
}) {
  return (
    <div className="chips" data-testid={`chips-${label}`}>
      <span className="chips__label">{label}:</span>
      {all.length === 0 && <span className="chips__none">none</span>}
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
