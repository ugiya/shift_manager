"""Human-readable flag derivation (Compromises + Infeasibilities).

Mirrors `constraints.py` exactly, but produces rich messages naming the
employees and shifts involved -- this is the list shown in the UI's flags panel
and asserted by tests. Tests also cross-check the count of HARD flags here
against Timefold's authoritative hard score, so the two cannot silently drift.
"""
from __future__ import annotations

from datetime import datetime
from itertools import combinations

from .config import (DAYS_IN_WEEK, LEGAL_REST_MINUTES, NIGHT_REST_MINUTES,
                     W_CONSECUTIVE_WEEKEND, W_EXCEPTIONAL, W_FAIRNESS,
                     W_NIGHT_RECOVERY, W_ONE_SHIFT_PER_DAY, W_PREFERENCE,
                     W_PREFERRED_SHIFT_TYPE, W_SIXTH_DAY, W_UNDERSTAFF)
from .domain import Schedule, Seat, Shift

HARD_WEIGHT = 10_000  # for sorting only; hard always sorts above soft


def _overlap(a: Shift, b: Shift) -> bool:
    return a.start_dt < b.end_dt and b.start_dt < a.end_dt


def _gap_minutes(end: datetime, start: datetime) -> float:
    return (start - end).total_seconds() / 60.0


def _ordered(a: Seat, b: Seat) -> tuple[Seat, Seat]:
    return (a, b) if a.shift.start_dt <= b.shift.start_dt else (b, a)


def _hours(minutes: float) -> str:
    return f"{minutes / 60:.1f}h"


def shift_label(shift: Shift) -> str:
    d = shift.start_dt
    return f"{shift.shift_type.name} · {d:%a %d %b}"


def seat_label(seat: Seat, schedule_lookup: dict) -> str:
    if seat.kind == "manager":
        team = schedule_lookup["teams"].get(seat.team_id, seat.team_id)
        return f"Shift Manager · {team}"
    project = schedule_lookup["projects"].get(seat.project_id, seat.project_id)
    role = schedule_lookup["roles"].get(seat.role_id, seat.role_id)
    return f"{role} · {project}"


def _flag(rule, kind, weight, title, detail, *, employee=None, shift=None, seats=()):
    key = "|".join([rule, str(employee), str(shift), *sorted(s.id for s in seats)])
    return {
        "id": key,
        "rule": rule,
        "kind": kind,                       # 'hard' (Infeasibility) | 'soft' (Compromise)
        "weight": HARD_WEIGHT if kind == "hard" else weight,
        "title": title,
        "detail": detail,
        "employee_id": employee,
        "shift_id": shift,
        "seat_ids": [s.id for s in seats],
    }


def derive_flags(schedule: Schedule, lookup: dict | None = None) -> list[dict]:
    lookup = lookup or _build_lookup(schedule)
    emp_name = lambda e: lookup["employees"].get(e.id, e.id) if e else "?"
    flags: list[dict] = []
    assigned = [s for s in schedule.seats if s.employee is not None]

    # group seats by employee
    by_emp: dict[str, list[Seat]] = {}
    for s in assigned:
        by_emp.setdefault(s.employee.id, []).append(s)

    # R1 one assignment per moment (hard)
    for a, b in combinations(assigned, 2):
        if a.employee.id == b.employee.id and _overlap(a.shift, b.shift):
            flags.append(_flag(
                "R1", "hard", 0,
                f"{emp_name(a.employee)} double-booked",
                f"Assigned to two overlapping shifts: "
                f"{shift_label(a.shift)} and {shift_label(b.shift)}. Neither seat counts as filled.",
                employee=a.employee.id, seats=(a, b)))

    # per-employee day stats
    for emp_id, seats in by_emp.items():
        emp = seats[0].employee
        days = {s.shift.start_date for s in seats}
        # R2 >= 1 day off per week (hard)
        if len(days) >= DAYS_IN_WEEK:
            flags.append(_flag(
                "R2", "hard", 0,
                f"{emp_name(emp)} has no day off",
                f"Working all {len(days)} days this week — the legal floor of one day off is broken.",
                employee=emp_id))
        # R8 preferred second day off (soft-mild)
        elif len(days) == DAYS_IN_WEEK - 1:
            flags.append(_flag(
                "R8", "soft", W_SIXTH_DAY,
                f"{emp_name(emp)} works 6 days",
                f"Only one day off this week; the preferred second day off is not met.",
                employee=emp_id))
        # R5 at most one shift per day (soft-strong)
        per_day: dict = {}
        for s in seats:
            per_day.setdefault(s.shift.start_date, []).append(s)
        for d, day_seats in per_day.items():
            if len(day_seats) > 1:
                flags.append(_flag(
                    "R5", "soft", W_ONE_SHIFT_PER_DAY,
                    f"{emp_name(emp)} has {len(day_seats)} shifts on {d:%a %d %b}",
                    "More than one shift on the same calendar day.",
                    employee=emp_id, seats=tuple(day_seats)))

    # R3 / R6 pairwise rest (within week)
    for emp_id, seats in by_emp.items():
        emp = seats[0].employee
        for a, b in combinations(seats, 2):
            if _overlap(a.shift, b.shift):
                continue
            first, second = _ordered(a, b)
            gap = _gap_minutes(first.shift.end_dt, second.shift.start_dt)
            if gap < 0:
                continue
            if gap < LEGAL_REST_MINUTES:
                flags.append(_flag(
                    "R3", "hard", 0,
                    f"{emp_name(emp)} has too little rest",
                    f"Only {_hours(gap)} between {shift_label(first.shift)} and "
                    f"{shift_label(second.shift)} (legal minimum {_hours(LEGAL_REST_MINUTES)}).",
                    employee=emp_id, seats=(first, second)))
            if first.shift.is_night and gap < NIGHT_REST_MINUTES:
                flags.append(_flag(
                    "R6", "soft", W_NIGHT_RECOVERY,
                    f"{emp_name(emp)} short night recovery",
                    f"Only {_hours(gap)} after night shift {shift_label(first.shift)} "
                    f"(recommended {_hours(NIGHT_REST_MINUTES)}).",
                    employee=emp_id, seats=(first, second)))

    # R3 / R6 carry-over across the week boundary. Mirrors constraints.py exactly:
    # last week's shift is paired with EACH current-week seat (per-seat, like the
    # within-week pairwise R3), and a negative gap is a hard cross-boundary overlap
    # that R1 cannot see — so there is no lower bound on the gap.
    for emp_id, seats in by_emp.items():
        emp = seats[0].employee
        if emp.prev_shift_end is None:
            continue
        for s in seats:
            gap = _gap_minutes(emp.prev_shift_end, s.shift.start_dt)
            if gap < LEGAL_REST_MINUTES:
                detail = (f"Overlaps last week's shift — no rest before "
                          f"{shift_label(s.shift)}." if gap < 0 else
                          f"Only {_hours(gap)} between last week's shift and "
                          f"{shift_label(s.shift)} (legal minimum {_hours(LEGAL_REST_MINUTES)}).")
                flags.append(_flag(
                    "R3", "hard", 0,
                    f"{emp_name(emp)} too little rest from last week",
                    detail, employee=emp_id, seats=(s,)))
            if emp.prev_shift_was_night and gap < NIGHT_REST_MINUTES:
                detail = (f"Overlaps last week's night shift — no recovery before "
                          f"{shift_label(s.shift)}." if gap < 0 else
                          f"Only {_hours(gap)} after last week's night shift before "
                          f"{shift_label(s.shift)} (recommended {_hours(NIGHT_REST_MINUTES)}).")
                flags.append(_flag(
                    "R6", "soft", W_NIGHT_RECOVERY,
                    f"{emp_name(emp)} short night recovery from last week",
                    detail, employee=emp_id, seats=(s,)))

    # R7 no consecutive weekends (soft-strong)
    for emp_id, seats in by_emp.items():
        emp = seats[0].employee
        wk = [s for s in seats if s.shift.is_weekend]
        if wk and emp.worked_last_weekend:
            flags.append(_flag(
                "R7", "soft", W_CONSECUTIVE_WEEKEND,
                f"{emp_name(emp)} works a 2nd weekend in a row",
                f"Assigned a weekend shift ({shift_label(wk[0].shift)}) after working last weekend.",
                employee=emp_id, seats=tuple(wk)))

    # R10 respect preferences (soft-mild)
    for s in assigned:
        if s.shift.id in s.employee.avoid_shift_ids:
            flags.append(_flag(
                "R10", "soft", W_PREFERENCE,
                f"{emp_name(s.employee)} works an avoided shift",
                f"{emp_name(s.employee)} preferred not to work {shift_label(s.shift)}.",
                employee=s.employee.id, shift=s.shift.id, seats=(s,)))

    # R11 honor preferred shift type (soft-mild): assigned a type not among the
    # employee's (non-empty) preferences. Shares Seat.is_dispreferred_type() with
    # constraints.preferred_shift_type so the two cannot drift.
    for s in assigned:
        if s.is_dispreferred_type():
            flags.append(_flag(
                "R11", "soft", W_PREFERRED_SHIFT_TYPE,
                f"{emp_name(s.employee)} works a non-preferred shift type",
                f"{emp_name(s.employee)} was assigned {shift_label(s.shift)} "
                f"({s.shift.shift_type.name}), which isn't among their preferred shift types.",
                employee=s.employee.id, shift=s.shift.id, seats=(s,)))

    # Exceptional Assignment (soft, override-only). When the cause is the employee's
    # Unavailability on the shift's date, name it — that's the actionable detail.
    for s in assigned:
        if not s.is_eligible(s.employee):
            if s.shift.start_date in s.employee.unavailable_dates:
                detail = (f"{emp_name(s.employee)} is unavailable on "
                          f"{s.shift.start_dt:%a %d %b} but was assigned "
                          f"{seat_label(s, lookup)} — needs sign-off.")
            else:
                detail = (f"{emp_name(s.employee)} is outside the normal eligibility for "
                          f"{seat_label(s, lookup)} and needs sign-off.")
            flags.append(_flag(
                "EXC", "soft", W_EXCEPTIONAL,
                f"{emp_name(s.employee)} — exceptional assignment",
                detail,
                employee=s.employee.id, shift=s.shift.id, seats=(s,)))

    # R4 exact demand — understaffing (soft)
    for s in schedule.seats:
        if s.employee is None:
            flags.append(_flag(
                "R4", "soft", W_UNDERSTAFF,
                f"Unfilled: {seat_label(s, lookup)}",
                f"No eligible employee available for {seat_label(s, lookup)} on "
                f"{shift_label(s.shift)}.",
                shift=s.shift.id, seats=(s,)))

    # R9 fairness — surface only when the burden spread is notable (soft objective)
    flags.extend(_fairness_flags(schedule, by_emp, lookup))

    flags.sort(key=lambda f: (-f["weight"], f["rule"]))
    return flags


def _fairness_flags(schedule: Schedule, by_emp: dict, lookup: dict) -> list[dict]:
    out: list[dict] = []
    # total burden = carry-over + this week's burden seats, grouped by team
    by_team: dict[str, dict[str, tuple]] = {}
    for emp in schedule.employees:
        this_week = sum(1 for s in by_emp.get(emp.id, []) if s.is_burden)
        total = emp.carryover_burden + this_week
        by_team.setdefault(emp.team_id, {})[emp.id] = (emp, total, this_week)
    for team_id, members in by_team.items():
        totals = [t for (_e, t, _w) in members.values()]
        this_week_total = sum(w for (_e, _t, w) in members.values())
        if not totals or this_week_total == 0:
            # Fairness is only actionable when burdens are actually handed out this
            # week; pure carry-over imbalance with nothing to assign is not a flag.
            continue
        spread = max(totals) - min(totals)
        if spread >= 2:
            team = lookup["teams"].get(team_id, team_id)
            top = max(members.values(), key=lambda v: v[1])
            out.append(_flag(
                "R9", "soft", W_FAIRNESS,
                f"Burden imbalance in {team}",
                f"Burden shifts (night/weekend) are uneven across {team}: "
                f"spread of {spread} between the most- and least-loaded member "
                f"(most loaded: {lookup['employees'].get(top[0].id, top[0].id)}).",
                employee=None))
    return out


def _build_lookup(schedule: Schedule) -> dict:
    return {
        "employees": {e.id: e.name for e in schedule.employees},
        "teams": {},
        "projects": {},
        "roles": {},
    }
