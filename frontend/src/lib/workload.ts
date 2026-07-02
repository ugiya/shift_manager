import type { Assignments, Dataset, Employee } from "../types";

// Workload summary — the fairness picture next to the schedule. Derived entirely from
// the dataset payload + current assignments (frontend-only, like the four views).
//
// "Burden" here mirrors the domain's Seat.is_burden: a night-or-weekend SEAT, counted
// per seat exactly like the fairness rule (R9) and the carry-over seed count it — a
// double-booked employee accrues burden per seat, and this panel must agree with the
// scoring authority. The human-facing shift/night/weekend columns count DISTINCT
// shifts instead (that's what "how many nights do I work" means to a person).

export interface WorkloadRow {
  employee: Employee;
  teamName: string;
  /** Distinct shifts the person is assigned to this week (a double-booking counts once). */
  shifts: number;
  nights: number;
  weekends: number;
  /** Night-or-weekend SEATS this week (the fairness currency — per seat, like R9). */
  weekBurden: number;
  /** carryover_burden + weekBurden — the cumulative fairness standing. */
  totalBurden: number;
  /** Average totalBurden across the person's team (active roster). */
  teamAvg: number;
}

export function workloadRows(ds: Dataset, assignments: Assignments): WorkloadRow[] {
  const shiftById = new Map(ds.shifts.map((s) => [s.id, s]));
  const seatById = new Map(ds.seats.map((s) => [s.id, s]));
  const teamName = new Map(ds.teams.map((t) => [t.id, t.name]));

  // Distinct shifts per employee (display) AND burden per seat (fairness parity with
  // R9/carry-over — a double-booking counts once as a shift but twice as burden).
  const shiftsByEmp = new Map<string, Set<string>>();
  const seatBurdenByEmp = new Map<string, number>();
  for (const [seatId, empId] of Object.entries(assignments)) {
    if (!empId) continue;
    const seat = seatById.get(seatId);
    const sh = seat && shiftById.get(seat.shift_id);
    if (!seat || !sh) continue;
    const set = shiftsByEmp.get(empId) ?? new Set<string>();
    set.add(seat.shift_id);
    shiftsByEmp.set(empId, set);
    if (sh.is_night || sh.is_weekend) {
      seatBurdenByEmp.set(empId, (seatBurdenByEmp.get(empId) ?? 0) + 1);
    }
  }

  const rows: WorkloadRow[] = ds.employees.map((e) => {
    let nights = 0, weekends = 0;
    const weekBurden = seatBurdenByEmp.get(e.id) ?? 0;
    const shiftIds = shiftsByEmp.get(e.id) ?? new Set<string>();
    for (const id of shiftIds) {
      const sh = shiftById.get(id);
      if (!sh) continue;
      if (sh.is_night) nights++;
      if (sh.is_weekend) weekends++;
    }
    return {
      employee: e,
      teamName: teamName.get(e.team_id) ?? e.team_id,
      shifts: shiftIds.size,
      nights,
      weekends,
      weekBurden,
      totalBurden: e.carryover_burden + weekBurden,
      teamAvg: 0, // filled below once every row's total is known
    };
  });

  const byTeam = new Map<string, WorkloadRow[]>();
  for (const r of rows) {
    const arr = byTeam.get(r.employee.team_id) ?? [];
    arr.push(r);
    byTeam.set(r.employee.team_id, arr);
  }
  for (const arr of byTeam.values()) {
    const avg = arr.reduce((s, r) => s + r.totalBurden, 0) / arr.length;
    for (const r of arr) r.teamAvg = avg;
  }

  // Heaviest first — that's who the scheduler needs to see; ties by name for stability.
  return rows.sort((a, b) =>
    b.totalBurden - a.totalBurden || a.employee.name.localeCompare(b.employee.name));
}
