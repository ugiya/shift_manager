"""Next-week Carry-over derivation (ADR-0002).

ADR-0002: schedules are continuous across weeks. The *accepted* Schedule for one
week — including any manual Overrides — is the source of the next week's
Carry-over. The service stays stateless (main.py): it persists nothing and
instead derives the seed here and hands it back, so the client can replay it as
next week's requirements input.

`next_week_carryover(schedule)` turns an assigned Schedule into a
``{employee_id: {carry-over fields}}`` map whose keys and value shapes match
`EmployeeIn`, so each entry can be pasted straight onto next week's employee.
The four fields mirror the carry-over inputs they will feed:

  * carryover_burden     — cumulative burden shifts (R9 fairness), rolled forward
  * worked_last_weekend  — did they work a weekend shift this week? (R7)
  * prev_shift_end        — end of their last shift this week (R3/R6 across boundary)
  * prev_shift_was_night  — was that last shift a Night Shift? (R6)
"""
from __future__ import annotations

from datetime import date, timedelta

from .config import MAX_CARRYOVER_BURDEN
from .domain import Schedule


def next_week_carryover(schedule: Schedule) -> dict[str, dict]:
    """Derive each employee's carry-over for the week *after* this Schedule.

    Overrides are already baked into ``seat.employee`` (re-validation applies them
    before scoring), so this reads the schedule as accepted.
    """
    worked_by_emp: dict[str, list] = {}
    for seat in schedule.seats:
        if seat.employee is not None:
            worked_by_emp.setdefault(seat.employee.id, []).append(seat)

    out: dict[str, dict] = {}
    for emp in schedule.employees:
        worked = worked_by_emp.get(emp.id, [])
        # The latest shift end drives turnaround / night recovery across the boundary.
        # If several shifts tie on that end time (only reachable via an R1-infeasible
        # overlap, which also marks the seed source_feasible=False), report a night
        # conservatively — assume the longer recovery applies — so the seed never
        # under-states the rest the next week owes.
        last_end = max((s.shift.end_dt for s in worked), default=None)
        tied = [s for s in worked if s.shift.end_dt == last_end]
        burden_this_week = sum(1 for s in worked if s.is_burden)
        out[emp.id] = {
            # Rolling cumulative burden: prior weeks + this week (R9). Employees
            # who didn't work still carry their accumulated burden forward. Clamp to
            # the input cap so the seed always re-validates as next week's input.
            "carryover_burden": min(MAX_CARRYOVER_BURDEN,
                                    emp.carryover_burden + burden_this_week),
            # Next week's "last weekend" is this week's weekend (R7).
            "worked_last_weekend": any(s.shift.is_weekend for s in worked),
            # Local-naive ISO, matching the input contract (requirements.py).
            "prev_shift_end": last_end.isoformat() if last_end else None,
            "prev_shift_was_night": any(s.shift.is_night for s in tied),
        }
    return out


def carryover_seed(schedule: Schedule, week_start: date, *, feasible: bool) -> dict:
    """A self-describing seed envelope for the week *after* this Schedule (ADR-0002).

    Carries week identity (`source`/`target_week_start`) so the client cannot
    silently replay a wrong-week seed, and `source_feasible` so a seed derived from
    a hard-infeasible schedule (e.g. a bad Override) is not trusted blindly. The
    server replays it via `requirements.apply_carryover_seed`.
    """
    return {
        "source_week_start": week_start.isoformat(),
        "target_week_start": (week_start + timedelta(days=7)).isoformat(),
        "source_feasible": feasible,
        "employees": next_week_carryover(schedule),
    }


def empty_carryover_seed() -> dict:
    """Shape-stable empty envelope for error responses (no schedule to derive from)."""
    return {"source_week_start": None, "target_week_start": None,
            "source_feasible": False, "employees": {}}
