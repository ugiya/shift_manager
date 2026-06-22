"""Shared builders for scheduling tests.

Two builder styles:
  * ``shift_h`` — place a shift at an absolute number of hours after the week
    start. Ideal for rest-gap / night-recovery boundary tests (minute precision).
  * ``day_shift`` — place a shift on a weekday offset (0=Sun .. 6=Sat). Ideal for
    day-off / weekend / one-shift-per-day tests.

``evaluate`` scores a hand-set assignment with Timefold (authoritative) and derives
the human-readable flags, mirroring the Override re-validation path exactly.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta
from itertools import count

import pytest

from app.analysis import derive_flags
from app.config import LEGAL_REST_MINUTES, NIGHT_REST_MINUTES
from app.domain import Employee, Schedule, Seat, Shift, ShiftType
from app.solver import analyze

WEEK_SUN = date(2026, 6, 21)            # Sunday
BASE = datetime(2026, 6, 21, 0, 0)      # week start, midnight
LEGAL_H = LEGAL_REST_MINUTES / 60       # 8h
NIGHT_H = NIGHT_REST_MINUTES / 60       # 24h

_ids = count(1)


def _sid(prefix: str) -> str:
    return f"{prefix}-{next(_ids)}"


def emp(id, roles=("r",), projects=("p",), team="t1", **kw) -> Employee:
    return Employee(id, id.capitalize(), team, frozenset(roles), frozenset(projects), **kw)


def shift_h(start_h: float, dur_h: float, night=False, team="t1", id=None) -> Shift:
    """A shift starting ``start_h`` hours after the week's Sunday 00:00."""
    s = BASE + timedelta(hours=start_h)
    e = s + timedelta(hours=dur_h)
    sid = id or _sid("shift")
    st = ShiftType(f"st-{sid}", "S", night, s.hour, e.hour)
    return Shift(sid, st, team, "s1", s, e)


def day_shift(day_offset: int, start=8.0, dur=8.0, night=False, team="t1", id=None) -> Shift:
    return shift_h(day_offset * 24 + start, dur, night=night, team=team, id=id)


def seat(sh: Shift, eligible, employee=None, project="p", role="r", kind="worker",
         sid=None) -> Seat:
    return Seat(sid or _sid("seat"), kind, sh, sh.team_id, project, role,
               eligible=list(eligible), employee=employee)


def manager_seat(sh: Shift, eligible, employee=None, sid=None) -> Seat:
    return Seat(sid or _sid("mseat"), "manager", sh, sh.team_id, None, None,
               eligible=list(eligible), employee=employee)


def evaluate(seats, employees=None):
    """Score a hand-set assignment and return (timefold_score, flags)."""
    shifts = list({s.shift.id: s.shift for s in seats}.values())
    if employees is None:
        seen = {}
        for s in seats:
            for e in list(s.eligible) + ([s.employee] if s.employee else []):
                seen[e.id] = e
        employees = list(seen.values())
    sched = Schedule(list(employees), shifts, list(seats))
    analyze(sched)
    return sched.score, derive_flags(sched)


def rules(flags, kind=None):
    return [f["rule"] for f in flags if kind is None or f["kind"] == kind]


def has(flags, rule, kind=None):
    return rule in rules(flags, kind)


def hard_rules(flags):
    return rules(flags, "hard")


def soft_rules(flags):
    return rules(flags, "soft")


@pytest.fixture(scope="session")
def default_solution():
    """Solve the real seed dataset once for the whole session."""
    from app.data import build_lookup, build_schedule, default_dataset
    from app.solver import solve
    ds = default_dataset()
    solved = solve(build_schedule(ds), spent=10, unimproved=3)
    return ds, solved, build_lookup(ds)
