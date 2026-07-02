export interface NamedRef { id: string; name: string }

export interface Team { id: string; name: string; site_id: string }
export interface Project { id: string; name: string; team_ids: string[] } // ADR-0003: may span teams/sites
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
  prev_shift_end: string | null; // local-naive ISO datetime; R3/R6 across the week boundary
  prev_shift_was_night: boolean;
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
  weekend_weekdays: number[]; // Mon=0..Sun=6 — the weekend per backend config (drives shading)
  roles: NamedRef[];
  teams: Team[];
  projects: Project[];
  shift_types: ShiftType[];
  employees: Employee[];
  shifts: Shift[];
  seats: Seat[];
}

export interface ConstraintTotal {
  name: string;
  rule: string;
  kind: "hard" | "soft";            // domain taxonomy: Infeasibility | Compromise
  level: "hard" | "medium" | "soft"; // score level the penalty lands on
  match_count: number;
  score: string;
}
export interface ScoreInfo {
  score: string;
  hard_score: number;
  medium_score: number;             // demand coverage (R4) — above all soft rules
  soft_score: number;
  feasible: boolean;
  constraints: ConstraintTotal[];
}

export interface Flag {
  id: string;
  rule: string;
  kind: "hard" | "soft";
  weight: number;
  title: string;   // authoritative English rendering (backend)
  detail: string;
  // Machine-readable form (2026-07-02): a stable message id + the dynamic values
  // (names as entered, ISO dates, counts). lib/flagText.ts composes a Hebrew
  // sentence from these; missing/unknown msg falls back to the English text.
  msg?: string | null;
  params?: FlagParams;
  employee_id: string | null;
  shift_id: string | null;
  seat_ids: string[];
}
export interface FlagShiftRef { name: string; date: string }
export interface FlagSeatRef { kind: "manager" | "worker"; team?: string; role?: string; project?: string }
export interface FlagParams {
  employee?: string;
  shift?: FlagShiftRef;
  shift_a?: FlagShiftRef;
  shift_b?: FlagShiftRef;
  seat?: FlagSeatRef;
  date?: string;
  days?: number;
  count?: number;
  gap_h?: number;
  min_h?: number;
  rec_h?: number;
  overlap?: boolean;
  unavailable?: boolean;
  team?: string;
  spread?: number;
  top?: string;
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
// A `null` ref = its target was deleted in the editor ("Please choose" pending);
// the backend blocks with a clear "choose one" error until re-picked.
export interface ReqTeam { id: string; name: string; site: string | null }
// ADR-0003: one-or-more teams. `runs_this_week` is the per-week tick: unticked, the
// project stays in the org but materialises no seats this week. Optional because
// docs saved before 2026-07-02 lack it; absent means true.
export interface ReqProject { id: string; name: string; teams: string[]; runs_this_week?: boolean }
export interface ReqEmployee {
  id: string;
  name: string;
  team: string | null;
  roles: string[];
  projects: string[];
  can_manage: boolean;
  // HR metadata (round-trip only; only `status` affects scheduling — Phase 2).
  status: string; // "active" | "on-leave" | "inactive"; only active is scheduled
  employee_number: string | null;
  email: string | null;
  phone: string | null;
  hire_date: string | null;
  notes: string | null;
  // Carry-over (ADR-0002): prior-week state that feeds this week's solve.
  carryover_burden: number;
  worked_last_weekend: boolean;
  prev_shift_end: string | null; // local-naive ISO datetime; R3/R6 across the week boundary
  prev_shift_was_night: boolean;
  avoid_shift_ids: string[]; // negative preferences (R10); round-tripped, not yet edited here
  unavailable_dates: string[]; // ISO dates the person can't work (Phase 3); removed from eligibility
  preferred_shift_type_ids: string[]; // preferred shift TYPES (Phase 4, R11); unmet ⇒ soft penalty
}
export interface ReqDemand {
  team: string | null;
  shift_type: string | null;
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

// Per-employee carry-over fields (ADR-0002). Shapes match ReqEmployee's carry-over
// fields so each entry can be pasted onto / replayed for next week's employee.
export interface Carryover {
  carryover_burden: number;
  worked_last_weekend: boolean;
  prev_shift_end: string | null;
  prev_shift_was_night: boolean;
}

// Self-describing seed envelope for the *next* week, derived from an accepted
// Schedule. Carries week identity (so a wrong-week replay is rejected) and whether
// the source schedule was feasible. Submit it back verbatim as a request's
// `carryover_seed` to seed the following week.
export interface CarryoverSeed {
  source_week_start: string | null;
  target_week_start: string | null;
  source_feasible: boolean;
  employees: Record<string, Carryover>;
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
  next_carryover: CarryoverSeed;
}
export interface ValidateResponse extends BuildResult {
  assignments: Assignments;
  score: ScoreInfo | null;
  flags: Flag[];
  next_carryover: CarryoverSeed;
}

export const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
