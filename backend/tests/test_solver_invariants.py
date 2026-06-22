"""Data-driven invariants over the SOLVED 4-site schedule.

The session-scoped `default_solution` fixture solves once; every seat, employee
and shift is then checked individually (parametrized), so a violation points at
the exact entity. These are the hard guarantees any returned solution must keep.
"""
from __future__ import annotations

import pytest

from app.data import build_schedule, default_dataset

_DS = default_dataset()
_SCHED = build_schedule(_DS)
SEAT_IDS = [s.id for s in _SCHED.seats]
EMP_IDS = [e.id for e in _DS.employees]
SHIFT_IDS = [s.id for s in _SCHED.shifts]
TEAM_IDS = [t.id for t in _DS.teams]
SITE_IDS = [s.id for s in _DS.sites]
TEAM_SITE = {t.id: t.site_id for t in _DS.teams}


def _solved_seats(default_solution):
    _ds, solved, _lk = default_solution
    return solved.seats


# --- global feasibility (a couple of summary checks) -------------------------

def test_solution_is_feasible_and_fully_staffed(default_solution):
    from app.solver import score_breakdown
    _ds, solved, _lk = default_solution
    bd = score_breakdown(solved)
    assert bd["feasible"] and bd["hard_score"] == 0
    assert all(s.employee is not None for s in solved.seats)


# --- per-seat: every assignment respects eligibility -------------------------

@pytest.mark.parametrize("seat_id", SEAT_IDS)
def test_each_assignment_is_eligible(seat_id, default_solution):
    seat = next(s for s in _solved_seats(default_solution) if s.id == seat_id)
    if seat.employee is not None:
        assert seat.employee in seat.eligible, (
            f"{seat.employee.id} is not eligible for {seat_id}")


# --- per-employee: no double-booking, at least one day off -------------------

@pytest.mark.parametrize("emp_id", EMP_IDS)
def test_employee_not_double_booked(emp_id, default_solution):
    shifts = sorted((s.shift for s in _solved_seats(default_solution)
                     if s.employee and s.employee.id == emp_id),
                    key=lambda sh: sh.start_dt)
    for a, b in zip(shifts, shifts[1:]):
        assert not (a.start_dt < b.end_dt and b.start_dt < a.end_dt), (
            f"{emp_id} double-booked: {a.id} & {b.id}")


@pytest.mark.parametrize("emp_id", EMP_IDS)
def test_employee_has_at_least_one_day_off(emp_id, default_solution):
    days = {s.shift.start_date for s in _solved_seats(default_solution)
            if s.employee and s.employee.id == emp_id}
    assert len(days) <= 6, f"{emp_id} works all 7 days"


@pytest.mark.parametrize("emp_id", EMP_IDS)
def test_employee_only_assigned_within_own_team(emp_id, default_solution):
    """The solver never reaches across teams on its own (that needs sign-off)."""
    emp = next(e for e in _DS.employees if e.id == emp_id)
    for s in _solved_seats(default_solution):
        if s.employee and s.employee.id == emp_id:
            assert s.team_id == emp.team_id


# --- per-shift: a person can't hold two seats in the same shift --------------

@pytest.mark.parametrize("shift_id", SHIFT_IDS)
def test_no_employee_twice_in_the_same_shift(shift_id, default_solution):
    emps = [s.employee.id for s in _solved_seats(default_solution)
            if s.shift.id == shift_id and s.employee]
    assert len(emps) == len(set(emps)), f"someone holds two seats in {shift_id}"


# --- per-team: manager seats only filled by managers -------------------------

@pytest.mark.parametrize("team_id", TEAM_IDS)
def test_manager_seats_filled_by_managers(team_id, default_solution):
    for s in _solved_seats(default_solution):
        if s.team_id == team_id and s.kind == "manager" and s.employee:
            assert s.employee.can_manage, f"non-manager in a manager seat in {team_id}"


# --- per-site: every site is fully staffed -----------------------------------

@pytest.mark.parametrize("site_id", SITE_IDS)
def test_each_site_is_fully_staffed(site_id, default_solution):
    site_seats = [s for s in _solved_seats(default_solution) if TEAM_SITE[s.team_id] == site_id]
    assert site_seats, f"{site_id} has no seats"
    assert all(s.employee is not None for s in site_seats), f"{site_id} has an unfilled seat"
