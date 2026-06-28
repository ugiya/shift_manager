import { useMemo, useState } from "react";
import type { Assignments, Dataset, Employee, Seat, Shift } from "../types";
import { dayHeader, seatState } from "../lib/lookups";

// Phase 6 + Round 2 #4: people-as-rows roster (Team & Employee views). Each row is an
// employee; each column is a day; a cell shows the shift(s) that person works that day AND
// lets you EDIT the assignment: a "+ assign" opens a seat-picker (eligible seats first, then
// "exceptional/needs-sign-off", then "replace someone" for occupied seats), and each shift
// chip has an × to remove it. Assignment edits are immediate (re-validate the whole week) —
// the same contract as the Site grid. The picker is scoped to the person's own team's seats
// that day; cross-team exceptional fills still go through the Site grid.
//
// `locked` (unsaved requirement edits, or a rebuild in flight) makes the roster read-only:
// the next Save rebuilds the schedule and clears assignments, so an edit now would be lost.

interface Assigned { seat: Seat; shift: Shift }

function buildIndex(ds: Dataset) {
  const shiftById = new Map(ds.shifts.map((s) => [s.id, s]));
  const seatsByTeamDate = new Map<string, Seat[]>();
  for (const seat of ds.seats) {
    const sh = shiftById.get(seat.shift_id);
    if (!sh) continue;
    const key = `${seat.team_id}|${sh.date}`;
    const arr = seatsByTeamDate.get(key) ?? [];
    arr.push(seat);
    seatsByTeamDate.set(key, arr);
  }
  return { shiftById, seatsByTeamDate };
}

function assignedIndex(ds: Dataset, assignments: Assignments, shiftById: Map<string, Shift>) {
  const idx = new Map<string, Map<string, Assigned[]>>();
  const seatById = new Map(ds.seats.map((s) => [s.id, s]));
  for (const [seatId, empId] of Object.entries(assignments)) {
    if (!empId) continue;
    const seat = seatById.get(seatId);
    const shift = seat && shiftById.get(seat.shift_id);
    if (!seat || !shift) continue;
    const byDate = idx.get(empId) ?? new Map<string, Assigned[]>();
    const arr = byDate.get(shift.date) ?? [];
    arr.push({ seat, shift });
    byDate.set(shift.date, arr);
    idx.set(empId, byDate);
  }
  return idx;
}

function RosterTable({ ds, employees, assignments, onChange, locked }: {
  ds: Dataset; employees: Employee[]; assignments: Assignments;
  onChange: (seatId: string, employeeId: string | null) => void; locked: boolean;
}) {
  const { shiftById, seatsByTeamDate } = useMemo(() => buildIndex(ds), [ds]);
  const assigned = useMemo(() => assignedIndex(ds, assignments, shiftById), [ds, assignments, shiftById]);
  const empName = useMemo(() => new Map(ds.employees.map((e) => [e.id, e.name])), [ds]);
  const [open, setOpen] = useState<string | null>(null); // `${empId}|${date}` of the open picker

  return (
    <div className="grid-scroll">
      <div className="roster" style={{ gridTemplateColumns: `var(--rowhdr) repeat(7, minmax(120px, 1fr))` }}>
        <div className="grid__corner" />
        {ds.days.map((d) => {
          const h = dayHeader(d);
          return (
            <div key={d} className={`grid__dayhdr${h.weekend ? " is-weekend" : ""}`}>
              <span className="grid__dayname">{h.name}</span>
              <span className="grid__daydom">{h.dom}</span>
            </div>
          );
        })}
        {employees.map((e) => (
          <div key={e.id} className="roster__row" data-testid="roster-row" data-emp-id={e.id} style={{ display: "contents" }}>
            <div className="grid__rowhdr roster__name">{e.name}</div>
            {ds.days.map((d) => {
              const cells = assigned.get(e.id)?.get(d) ?? [];
              const weekend = dayHeader(d).weekend;
              const key = `${e.id}|${d}`;
              return (
                <div key={d} className={`rocell${weekend ? " is-weekend" : ""}`} data-testid="roster-cell">
                  {cells.map(({ seat, shift }) => {
                    const exceptional = seatState(seat, e.id) === "exceptional";
                    return (
                      <span key={seat.id}
                        className={`rochip${shift.is_night ? " is-night" : ""}${exceptional ? " is-exc" : ""}`}
                        data-testid="roster-chip" data-seat-id={seat.id}>
                        {seat.kind === "manager" && <span aria-hidden>★</span>} {shift.shift_type_name}
                        {!locked && (
                          <button type="button" className="rochip__rm" data-testid="roster-remove"
                            title="Remove from this shift" onClick={() => onChange(seat.id, null)}>×</button>
                        )}
                      </span>
                    );
                  })}
                  {cells.length === 0 && locked && <span className="rocell__off">·</span>}
                  {!locked && (
                    <AssignControl
                      open={open === key} onOpen={() => setOpen(key)} onClose={() => setOpen(null)}
                      seats={seatsByTeamDate.get(`${e.team_id}|${d}`) ?? []}
                      shiftById={shiftById} assignments={assignments} empName={empName} emp={e}
                      onPick={(seatId) => { onChange(seatId, e.id); setOpen(null); }}
                    />
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function AssignControl({ open, onOpen, onClose, seats, shiftById, assignments, empName, emp, onPick }: {
  open: boolean; onOpen: () => void; onClose: () => void;
  seats: Seat[]; shiftById: Map<string, Shift>; assignments: Assignments;
  empName: Map<string, string>; emp: Employee; onPick: (seatId: string) => void;
}) {
  // The person's own team's seats that day they don't already fill. Open eligible seats first,
  // then open exceptional (needs sign-off), then occupied seats as an explicit "Replace someone".
  const choices = seats.filter((s) => assignments[s.id] !== emp.id);
  const sortKey = (s: Seat) => `${shiftById.get(s.shift_id)?.start ?? ""}|${s.label}`;
  const bySort = (a: Seat, b: Seat) => sortKey(a).localeCompare(sortKey(b));
  const open_ = choices.filter((s) => !assignments[s.id]);
  const eligibleOpen = open_.filter((s) => s.eligible_employee_ids.includes(emp.id)).sort(bySort);
  const exceptionalOpen = open_.filter((s) => !s.eligible_employee_ids.includes(emp.id)).sort(bySort);
  const occupied = choices.filter((s) => assignments[s.id]).sort(bySort);

  const option = (s: Seat, replace: boolean) => {
    const occ = assignments[s.id];
    const st = shiftById.get(s.shift_id)?.shift_type_name ?? "";
    const eligible = s.eligible_employee_ids.includes(emp.id);
    return (
      <button key={s.id} type="button" className={`roassign__opt${replace ? " is-replace" : ""}`}
        data-testid="roster-assign-option" data-seat-id={s.id} data-replace={replace} data-eligible={eligible}
        onClick={() => onPick(s.id)}>
        <span className="roassign__lbl">{s.kind === "manager" && <span aria-hidden>★</span>} {st} · {s.label}</span>
        <span className="roassign__occ">{occ ? `replaces ${empName.get(occ) ?? occ}` : eligible ? "unfilled" : "needs sign-off"}</span>
      </button>
    );
  };

  return (
    <div className="roassign">
      <button type="button" className="roassign__btn" data-testid="roster-assign"
        aria-expanded={open} onClick={open ? onClose : onOpen}>{open ? "× close" : "+ assign"}</button>
      {open && (
        <div className="roassign__menu" data-testid="roster-assign-menu" role="menu">
          {choices.length === 0 && <div className="roassign__empty">No seats for {emp.name}’s team this day.</div>}
          {eligibleOpen.length > 0 && <div className="roassign__group">Eligible</div>}
          {eligibleOpen.map((s) => option(s, false))}
          {exceptionalOpen.length > 0 && <div className="roassign__group">Exceptional (needs sign-off)</div>}
          {exceptionalOpen.map((s) => option(s, false))}
          {occupied.length > 0 && <div className="roassign__group roassign__group--replace">Replace someone</div>}
          {occupied.map((s) => option(s, true))}
        </div>
      )}
    </div>
  );
}

export default function RosterView({ ds, assignments, groupByTeam, onChange, locked }: {
  ds: Dataset; assignments: Assignments; groupByTeam: boolean;
  onChange: (seatId: string, employeeId: string | null) => void; locked: boolean;
}) {
  const byName = (a: Employee, b: Employee) => a.name.localeCompare(b.name);
  const lockHint = locked && (
    <div className="banner banner--warn" data-testid="roster-locked" role="status">
      Requirement changes pending — Save or Discard them (in Requirements or Project) to edit assignments here.
    </div>
  );

  if (!groupByTeam) {
    // Employee view: one flat roster of everyone, across all teams/sites.
    return (
      <div className="roster-view" data-testid="roster-view" data-mode="employee">
        {lockHint}
        <RosterTable ds={ds} employees={[...ds.employees].sort(byName)} assignments={assignments} onChange={onChange} locked={locked} />
      </div>
    );
  }
  // Team view: one roster section per team (under the selected site, passed pre-filtered).
  return (
    <div className="roster-view" data-testid="roster-view" data-mode="team">
      {lockHint}
      {ds.teams.map((team) => {
        const members = ds.employees.filter((e) => e.team_id === team.id).sort(byName);
        if (members.length === 0) return null;
        return (
          <section key={team.id} className="team" data-testid="roster-team" data-team-id={team.id}>
            <h2 className="team__title">{team.name}</h2>
            <RosterTable ds={ds} employees={members} assignments={assignments} onChange={onChange} locked={locked} />
          </section>
        );
      })}
    </div>
  );
}
