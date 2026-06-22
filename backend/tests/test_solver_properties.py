"""Emergent solver behaviour: invariants that must hold on any solution it returns,
plus best-effort behaviour on deliberately hard problems."""
from __future__ import annotations

from conftest import emp, seat, shift_h
from app.analysis import derive_flags
from app.domain import Schedule
from app.solver import score_breakdown, solve


def solve_seats(seats, employees, spent=2, unimproved=1):
    shifts = list({s.shift.id: s.shift for s in seats}.values())
    return solve(Schedule(list(employees), shifts, list(seats)), spent=spent, unimproved=unimproved)


# --- invariants on the real seed week ---------------------------------------

def test_default_is_feasible_and_fully_staffed(default_solution):
    _ds, solved, _lk = default_solution
    bd = score_breakdown(solved)
    assert bd["feasible"] and bd["hard_score"] == 0
    assert all(s.employee is not None for s in solved.seats)


def test_default_has_no_hard_flags(default_solution):
    _ds, solved, lk = default_solution
    assert [f for f in derive_flags(solved, lk) if f["kind"] == "hard"] == []


def test_default_every_assignment_is_eligible(default_solution):
    _ds, solved, _lk = default_solution
    assert all(s.employee in s.eligible for s in solved.seats if s.employee)


def test_default_no_exceptional_assignments_created_by_solver(default_solution):
    _ds, solved, lk = default_solution
    assert "EXC" not in [f["rule"] for f in derive_flags(solved, lk)]


def test_default_no_one_double_booked(default_solution):
    _ds, solved, _lk = default_solution
    by_emp: dict[str, list] = {}
    for s in solved.seats:
        if s.employee:
            by_emp.setdefault(s.employee.id, []).append(s.shift)
    for shifts in by_emp.values():
        shifts.sort(key=lambda sh: sh.start_dt)
        for x, y in zip(shifts, shifts[1:]):
            assert not (x.start_dt < y.end_dt and y.start_dt < x.end_dt)


def test_default_everyone_has_a_day_off(default_solution):
    _ds, solved, _lk = default_solution
    days_by_emp: dict[str, set] = {}
    for s in solved.seats:
        if s.employee:
            days_by_emp.setdefault(s.employee.id, set()).add(s.shift.start_date)
    assert all(len(days) <= 6 for days in days_by_emp.values())


def test_solving_twice_is_consistently_feasible(default_solution):
    ds, _solved, _lk = default_solution
    from app.data import build_schedule
    again = solve(build_schedule(ds), spent=6, unimproved=2)
    bd = score_breakdown(again)
    assert bd["feasible"] and all(s.employee is not None for s in again.seats)


# --- best-effort behaviour on hard problems ---------------------------------

def test_solver_leaves_a_seat_unfilled_rather_than_double_book():
    """Two seats in the same moment, only one eligible person -> one stays empty,
    the hard core is never violated."""
    a = emp("a")
    sh = shift_h(8, 8)
    s1, s2 = seat(sh, [a], sid="s1"), seat(sh, [a], sid="s2")
    solved = solve_seats([s1, s2], [a])
    filled = [s for s in solved.seats if s.employee]
    assert len(filled) == 1, "cannot place the same person in both seats at once"
    assert score_breakdown(solved)["hard_score"] == 0


def test_solver_reports_understaffing_when_capacity_is_short():
    a = emp("a")
    sh = shift_h(8, 8)
    seats = [seat(sh, [a], sid=f"k{i}") for i in range(3)]   # 3 seats, 1 person
    solved = solve_seats(seats, [a])
    unfilled = [s for s in solved.seats if s.employee is None]
    assert len(unfilled) == 2
    assert "R4" in [f["rule"] for f in derive_flags(solved)]
    assert score_breakdown(solved)["hard_score"] == 0


def test_solver_never_invents_an_ineligible_assignment_on_a_hard_problem():
    a, b = emp("a"), emp("b")
    sh = shift_h(8, 8)
    # seat only eligible for `a`; `b` exists but must never be auto-placed here
    s = seat(sh, [a], sid="s")
    solved = solve_seats([s], [a, b])
    assert solved.seats[0].employee in (a, None)


def test_solver_balances_burden_when_it_can():
    people = [emp(x) for x in ("a", "b", "c", "d")]
    seats = [seat(shift_h(d * 24 + 22, 8, night=True, id=f"n{d}"), people, sid=f"k{d}")
             for d in range(4)]
    solved = solve_seats(seats, people, spent=3, unimproved=1)
    counts: dict[str, int] = {}
    for s in solved.seats:
        if s.employee:
            counts[s.employee.id] = counts.get(s.employee.id, 0) + 1
    assert all(s.employee is not None for s in solved.seats)
    # optimum is one night each; allow a little slack but no heavy piling
    assert max(counts.values()) - min(counts.values() or [0]) <= 2
