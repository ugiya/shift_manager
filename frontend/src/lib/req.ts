import type { RequirementsDoc, ReqProject } from "../types";

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
  return req.projects.filter((p) => p.team === teamId);
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
  return req.demand.some((d) => d.shift_type === stId);
}

export function teamReferenced(req: RequirementsDoc, teamId: string): boolean {
  return (
    req.projects.some((p) => p.team === teamId) ||
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
