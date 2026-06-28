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

export function projectsForTeam(req: RequirementsDoc, teamId: string): ReqProject[] {
  return req.projects.filter((p) => p.teams.includes(teamId));
}

// --- reference checks: an entity referenced elsewhere can't be deleted ------

export function siteReferenced(req: RequirementsDoc, siteId: string): boolean {
  return req.teams.some((t) => t.site === siteId);
}

export function roleReferenced(req: RequirementsDoc, roleId: string): boolean {
  if (req.employees.some((e) => e.roles.includes(roleId))) return true;
  return req.demand.some((d) => Object.values(d.crew).some((roles) => roleId in roles));
}

export function shiftTypeReferenced(req: RequirementsDoc, stId: string): boolean {
  // Demand uses it, OR an employee prefers it (R11) — both make the id load-bearing, so
  // deletion is blocked while referenced (backend rejects a stale preferred id otherwise).
  if (req.demand.some((d) => d.shift_type === stId)) return true;
  return req.employees.some((e) => e.preferred_shift_type_ids.includes(stId));
}

export function teamReferenced(req: RequirementsDoc, teamId: string): boolean {
  return (
    req.projects.some((p) => p.teams.includes(teamId)) ||
    req.employees.some((e) => e.team === teamId) ||
    req.demand.some((d) => d.team === teamId)
  );
}

export function projectReferenced(req: RequirementsDoc, projectId: string): boolean {
  if (req.employees.some((e) => e.projects.includes(projectId))) return true;
  return req.demand.some((d) => projectId in d.crew);
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

/** Set the crew count for (team, shift_type, project, role). 0 removes it. Creates the
 *  demand row if needed (defaulting its days); never deletes a row (an empty-crew row is
 *  a valid manager-only shift, matching the Demand editor). */
export function setCrewCount(
  req: RequirementsDoc, team: string, shiftType: string, project: string, role: string, n: number,
): RequirementsDoc {
  const demand = cloneDemand(req.demand);
  let row = demand.find((d) => d.team === team && d.shift_type === shiftType);
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

/** Set which days the (team, shift_type) shift runs (shared by every project in that row). */
export function setDemandDays(
  req: RequirementsDoc, team: string, shiftType: string, days: string[],
): RequirementsDoc {
  const demand = cloneDemand(req.demand);
  const ordered = DAY_NAMES.filter((d) => days.includes(d));
  const row = demand.find((d) => d.team === team && d.shift_type === shiftType);
  if (row) row.days = ordered;
  else if (ordered.length) demand.push({ team, shift_type: shiftType, days: ordered, crew: {} });
  return { ...req, demand };
}
