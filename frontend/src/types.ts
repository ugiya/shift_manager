export interface NamedRef { id: string; name: string }

export interface Team { id: string; name: string; site_id: string }
export interface Project { id: string; name: string; team_id: string }
export interface ShiftType {
  id: string; name: string; is_night: boolean; start_hour: number; end_hour: number;
}

export interface Employee {
  id: string;
  name: string;
  team_id: string;
  role_ids: string[];
  project_ids: string[];
  can_manage: boolean;
  avoid_shift_ids: string[];
  carryover_burden: number;
  worked_last_weekend: boolean;
}

export interface Shift {
  id: string;
  shift_type_id: string;
  shift_type_name: string;
  team_id: string;
  site_id: string;
  date: string;
  weekday: number;
  start: string;
  end: string;
  is_night: boolean;
  is_weekend: boolean;
  label: string;
}

export interface Seat {
  id: string;
  kind: "worker" | "manager";
  shift_id: string;
  team_id: string;
  project_id: string | null;
  role_id: string | null;
  label: string;
  eligible_employee_ids: string[];
}

export interface Dataset {
  sites: NamedRef[];
  week_start: string;
  days: string[];
  roles: NamedRef[];
  teams: Team[];
  projects: Project[];
  shift_types: ShiftType[];
  employees: Employee[];
  shifts: Shift[];
  seats: Seat[];
}

export interface ConstraintTotal {
  name: string; rule: string; kind: "hard" | "soft"; match_count: number; score: string;
}
export interface ScoreInfo {
  score: string;
  hard_score: number;
  soft_score: number;
  feasible: boolean;
  constraints: ConstraintTotal[];
}

export interface Flag {
  id: string;
  rule: string;
  kind: "hard" | "soft";
  weight: number;
  title: string;
  detail: string;
  employee_id: string | null;
  shift_id: string | null;
  seat_ids: string[];
}

export type Assignments = Record<string, string | null>;

export interface SolveResult {
  assignments: Assignments;
  score: ScoreInfo;
  flags: Flag[];
}

// --- editable requirements document ----------------------------------------
export interface ReqSite { id: string; name: string }
export interface ReqRole { id: string; name: string }
export interface ReqShiftType { id: string; name: string; start: number; end: number; is_night: boolean }
export interface ReqTeam { id: string; name: string; site: string }
export interface ReqProject { id: string; name: string; team: string }
export interface ReqEmployee {
  id: string;
  name: string;
  team: string;
  roles: string[];
  projects: string[];
  can_manage: boolean;
  carryover_burden: number;
  worked_last_weekend: boolean;
}
export interface ReqDemand {
  team: string;
  shift_type: string;
  days: string[];
  crew: Record<string, Record<string, number>>; // project -> role -> count
}
export interface RequirementsDoc {
  sites: ReqSite[];
  roles: ReqRole[];
  shift_types: ReqShiftType[];
  teams: ReqTeam[];
  projects: ReqProject[];
  employees: ReqEmployee[];
  demand: ReqDemand[];
  week_start?: string;
  config?: { legal_rest_hours: number; night_rest_hours: number; weekend_days: string[] };
}

export interface BuildResult {
  errors: string[];
  warnings: string[];
  dataset: Dataset | null;
}
export interface SolveResponse extends BuildResult {
  assignments: Assignments;
  score: ScoreInfo | null;
  flags: Flag[];
}
export interface ValidateResponse extends BuildResult {
  assignments: Assignments;
  score: ScoreInfo | null;
  flags: Flag[];
}

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
