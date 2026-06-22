import type { Assignments, Dataset, Employee, Seat, Shift } from "../types";

export interface Lookups {
  empById: Map<string, Employee>;
  shiftById: Map<string, Shift>;
  seatsByShift: Map<string, Seat[]>;
  shiftTypeOrder: Map<string, number>;
}

export function buildLookups(ds: Dataset): Lookups {
  const empById = new Map(ds.employees.map((e) => [e.id, e]));
  const shiftById = new Map(ds.shifts.map((s) => [s.id, s]));
  const seatsByShift = new Map<string, Seat[]>();
  for (const seat of ds.seats) {
    const arr = seatsByShift.get(seat.shift_id) ?? [];
    arr.push(seat);
    seatsByShift.set(seat.shift_id, arr);
  }
  // sort seats within a shift: manager first, then by label
  for (const arr of seatsByShift.values()) {
    arr.sort((a, b) =>
      a.kind === b.kind ? a.label.localeCompare(b.label) : a.kind === "manager" ? -1 : 1,
    );
  }
  const shiftTypeOrder = new Map(
    [...ds.shift_types]
      .sort((a, b) => a.start_hour - b.start_hour)
      .map((st, i) => [st.id, i]),
  );
  return { empById, shiftById, seatsByShift, shiftTypeOrder };
}

export type SeatState = "filled" | "unfilled" | "exceptional";

export function seatState(seat: Seat, assignedId: string | null | undefined): SeatState {
  if (!assignedId) return "unfilled";
  return seat.eligible_employee_ids.includes(assignedId) ? "filled" : "exceptional";
}

export function shiftTypesForTeam(ds: Dataset, teamId: string, lk: Lookups) {
  const ids = new Set(
    ds.shifts.filter((s) => s.team_id === teamId).map((s) => s.shift_type_id),
  );
  return ds.shift_types
    .filter((st) => ids.has(st.id))
    .sort((a, b) => (lk.shiftTypeOrder.get(a.id)! - lk.shiftTypeOrder.get(b.id)!));
}

export function findShift(
  ds: Dataset,
  teamId: string,
  shiftTypeId: string,
  date: string,
): Shift | undefined {
  return ds.shifts.find(
    (s) => s.team_id === teamId && s.shift_type_id === shiftTypeId && s.date === date,
  );
}

export const WEEKDAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function dayHeader(dateIso: string): { name: string; dom: string; weekend: boolean } {
  const d = new Date(dateIso + "T00:00:00");
  const jsDay = d.getDay(); // 0=Sun..6=Sat
  const pyWeekday = (jsDay + 6) % 7; // Mon=0..Sun=6
  const name = WEEKDAY_NAMES[pyWeekday];
  return { name, dom: String(d.getDate()), weekend: pyWeekday === 4 || pyWeekday === 5 };
}

export function countFilled(ds: Dataset, assignments: Assignments): { filled: number; total: number } {
  const total = ds.seats.length;
  let filled = 0;
  for (const seat of ds.seats) if (assignments[seat.id]) filled++;
  return { filled, total };
}

export interface SiteIssue { unfilled: number; exceptional: number }

export function siteIssues(ds: Dataset, assignments: Assignments): Record<string, SiteIssue> {
  const teamSite = new Map(ds.teams.map((t) => [t.id, t.site_id]));
  const res: Record<string, SiteIssue> = {};
  for (const s of ds.sites) res[s.id] = { unfilled: 0, exceptional: 0 };
  for (const seat of ds.seats) {
    const site = teamSite.get(seat.team_id);
    if (!site || !res[site]) continue;
    const st = seatState(seat, assignments[seat.id] ?? null);
    if (st === "unfilled") res[site].unfilled++;
    else if (st === "exceptional") res[site].exceptional++;
  }
  return res;
}
