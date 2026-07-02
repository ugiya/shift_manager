import type { RequirementsDoc, ReqDemand, ReqProject } from "../types";
import { DAY_NAMES } from "../types";

let _counter = 0;

/** A short unique id, unique within the current doc. */
export function nextId(prefix: string, existing: string[]): string {
  const used = new Set(existing);
  let id: string;
  do {
    id = `${prefix}-${++_counter}`;
  } while (used.has(id));
  return id;
}

export function projectsForTeam(req: RequirementsDoc, teamId: string | null): ReqProject[] {
  return teamId == null ? [] : req.projects.filter((p) => p.teams.includes(teamId));
}

/** The per-week tick. Absent (docs saved before 2026-07-02) means running. */
export function runsThisWeek(p: ReqProject): boolean {
  return p.runs_this_week !== false;
}

// --- deletes: always allowed; references become null ("Please choose") -------
// The user's chosen model (2026-07-02): deleting an entity never blocks and never
// cascades — single refs turn into a pending choice (null → the editor renders
// "Please choose", validation says "choose one"), list/keyed refs drop the entry.

const dropCrewEntry = (
  crew: Record<string, Record<string, number>>,
  keep: (pid: string, rid: string) => boolean,
) => {
  const next: Record<string, Record<string, number>> = {};
  for (const [pid, roles] of Object.entries(crew)) {
    const kept = Object.fromEntries(Object.entries(roles).filter(([rid]) => keep(pid, rid)));
    if (Object.keys(kept).length) next[pid] = kept;
  }
  return next;
};

export function deleteSite(req: RequirementsDoc, siteId: string): RequirementsDoc {
  return {
    ...req,
    sites: req.sites.filter((s) => s.id !== siteId),
    teams: req.teams.map((t) => (t.site === siteId ? { ...t, site: null } : t)),
  };
}

export function deleteRole(req: RequirementsDoc, roleId: string): RequirementsDoc {
  return {
    ...req,
    roles: req.roles.filter((r) => r.id !== roleId),
    employees: req.employees.map((e) =>
      e.roles.includes(roleId) ? { ...e, roles: e.roles.filter((r) => r !== roleId) } : e),
    demand: req.demand.map((d) => ({ ...d, crew: dropCrewEntry(d.crew, (_p, rid) => rid !== roleId) })),
  };
}

export function deleteShiftType(req: RequirementsDoc, stId: string): RequirementsDoc {
  return {
    ...req,
    shift_types: req.shift_types.filter((s) => s.id !== stId),
    demand: req.demand.map((d) => (d.shift_type === stId ? { ...d, shift_type: null } : d)),
    employees: req.employees.map((e) =>
      e.preferred_shift_type_ids.includes(stId)
        ? { ...e, preferred_shift_type_ids: e.preferred_shift_type_ids.filter((x) => x !== stId) }
        : e),
  };
}

export function deleteTeam(req: RequirementsDoc, teamId: string): RequirementsDoc {
  return {
    ...req,
    teams: req.teams.filter((t) => t.id !== teamId),
    // A project losing its last team keeps an empty list — validation asks for a team.
    projects: req.projects.map((p) =>
      p.teams.includes(teamId) ? { ...p, teams: p.teams.filter((x) => x !== teamId) } : p),
    employees: req.employees.map((e) => (e.team === teamId ? { ...e, team: null } : e)),
    demand: req.demand.map((d) => (d.team === teamId ? { ...d, team: null } : d)),
  };
}

export function deleteProject(req: RequirementsDoc, projectId: string): RequirementsDoc {
  return {
    ...req,
    projects: req.projects.filter((p) => p.id !== projectId),
    employees: req.employees.map((e) =>
      e.projects.includes(projectId)
        ? { ...e, projects: e.projects.filter((x) => x !== projectId) }
        : e),
    demand: req.demand.map((d) =>
      projectId in d.crew ? { ...d, crew: dropCrewEntry(d.crew, (pid) => pid !== projectId) } : d),
  };
}

/** Tidy a demand row's crew when its team changes: drop projects not in the team. */
export function pruneCrew(req: RequirementsDoc, teamId: string, crew: Record<string, Record<string, number>>) {
  const valid = new Set(projectsForTeam(req, teamId).map((p) => p.id));
  const next: Record<string, Record<string, number>> = {};
  for (const [pid, roles] of Object.entries(crew)) if (valid.has(pid)) next[pid] = roles;
  return next;
}

// --- Round 2 #2: project-scoped demand editing -----------------------------
// Demand is keyed by (team, shift_type); a row carries `days` (shared by all the
// projects in that row) and `crew[project][role] = count`. These helpers let the
// Project view edit a project's requirement per (team, shift_type, role) without
// reaching into the raw shape. They return a NEW doc (no in-place mutation).

const cloneDemand = (d: ReqDemand[]): ReqDemand[] =>
  d.map((r) => ({ ...r, days: [...r.days], crew: Object.fromEntries(
    Object.entries(r.crew).map(([p, roles]) => [p, { ...roles }])) }));

/** Days a NEW demand row should default to: the union of the team's existing demand
 *  days (so a new shift runs when the team already runs), in week order; else Sunday. */
function defaultDaysForTeam(req: RequirementsDoc, teamId: string): string[] {
  const days = new Set<string>();
  for (const d of req.demand) if (d.team === teamId) for (const day of d.days) days.add(day);
  const ordered = DAY_NAMES.filter((d) => days.has(d));
  return ordered.length ? ordered : ["Sun"];
}

// A (team, shift_type) pair may legitimately appear in SEVERAL demand rows with
// disjoint day sets (per-day crew variation — the backend rejects only overlapping
// days). The Project view therefore addresses a row by INDEX; the pair alone is
// ambiguous. rowIndex is optional so a stepper on a not-yet-materialised requirement
// can still create the row.

/** Set the crew count for a demand row's (project, role). 0 removes it. When rowIndex is
 *  null/stale, falls back to the first (team, shift_type) row, creating it if needed
 *  (defaulting its days); never deletes a row (an empty-crew row is a valid manager-only
 *  shift, matching the Demand editor). */
export function setCrewCount(
  req: RequirementsDoc, team: string, shiftType: string, project: string, role: string, n: number,
  rowIndex?: number,
): RequirementsDoc {
  const demand = cloneDemand(req.demand);
  const at = rowIndex != null ? demand[rowIndex] : undefined;
  let row = at && at.team === team && at.shift_type === shiftType
    ? at
    : demand.find((d) => d.team === team && d.shift_type === shiftType);
  if (n > 0) {
    if (!row) {
      row = { team, shift_type: shiftType, days: defaultDaysForTeam(req, team), crew: {} };
      demand.push(row);
    }
    row.crew[project] = row.crew[project] || {};
    row.crew[project][role] = n;
  } else if (row && row.crew[project]) {
    delete row.crew[project][role];
    if (Object.keys(row.crew[project]).length === 0) delete row.crew[project];
  }
  return { ...req, demand };
}

/** Set which days a demand row's shift runs (shared by every project in that row).
 *  Row addressed by index (see above); pair-lookup fallback for a stale/absent index. */
export function setDemandDays(
  req: RequirementsDoc, team: string, shiftType: string, days: string[],
  rowIndex?: number,
): RequirementsDoc {
  const demand = cloneDemand(req.demand);
  const ordered = DAY_NAMES.filter((d) => days.includes(d));
  const at = rowIndex != null ? demand[rowIndex] : undefined;
  const row = at && at.team === team && at.shift_type === shiftType
    ? at
    : demand.find((d) => d.team === team && d.shift_type === shiftType);
  if (row) row.days = ordered;
  else if (ordered.length) demand.push({ team, shift_type: shiftType, days: ordered, crew: {} });
  return { ...req, demand };
}
