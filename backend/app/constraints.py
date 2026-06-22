"""Constraint provider: the hard core + soft rules from CONTEXT.md.

`for_each(Seat)` yields only ASSIGNED seats (the planning variable is nullable),
so `s.employee` is never None inside these streams. Unassigned seats are reached
only via `for_each_including_unassigned` (used for under-staffing).
"""
from __future__ import annotations

from datetime import datetime

from timefold.solver.score import (ConstraintCollectors, ConstraintFactory, Constraint,
                                    HardSoftScore, Joiners, constraint_provider)

from .config import (DAYS_IN_WEEK, LEGAL_REST_MINUTES, NIGHT_REST_MINUTES,
                     W_CONSECUTIVE_WEEKEND, W_EXCEPTIONAL, W_FAIRNESS,
                     W_NIGHT_RECOVERY, W_ONE_SHIFT_PER_DAY, W_PREFERENCE,
                     W_SIXTH_DAY, W_UNDERSTAFF)
from .domain import Seat, Shift


# --- Constraint names + metadata (used by the solver service for reporting) ---
# kind: 'hard' -> Infeasibility, 'soft' -> Compromise
CONSTRAINTS: dict[str, dict] = {
    "R1 one assignment per moment": {"kind": "hard", "rule": "R1"},
    "R2 at least one day off per week": {"kind": "hard", "rule": "R2"},
    "R3 legal turnaround rest": {"kind": "hard", "rule": "R3"},
    "R3 legal turnaround rest (carry-over)": {"kind": "hard", "rule": "R3"},
    "R4 exact demand (understaffing)": {"kind": "soft", "rule": "R4"},
    "R5 at most one shift per day": {"kind": "soft", "rule": "R5"},
    "R6 night recovery": {"kind": "soft", "rule": "R6"},
    "R6 night recovery (carry-over)": {"kind": "soft", "rule": "R6"},
    "R7 no consecutive weekends": {"kind": "soft", "rule": "R7"},
    "R8 preferred second day off": {"kind": "soft", "rule": "R8"},
    "R9 fairness (burden balance)": {"kind": "soft", "rule": "R9"},
    "R10 respect preferences": {"kind": "soft", "rule": "R10"},
    "Exceptional Assignment (needs sign-off)": {"kind": "soft", "rule": "EXC"},
}


# --- helpers -----------------------------------------------------------------

def _overlap(a: Shift, b: Shift) -> bool:
    return a.start_dt < b.end_dt and b.start_dt < a.end_dt


def _gap_minutes(end: datetime, start: datetime) -> float:
    return (start - end).total_seconds() / 60.0


def _ordered(a: Seat, b: Seat) -> tuple[Seat, Seat]:
    return (a, b) if a.shift.start_dt <= b.shift.start_dt else (b, a)


def _pair_gap_minutes(a: Seat, b: Seat) -> float:
    first, second = _ordered(a, b)
    return _gap_minutes(first.shift.end_dt, second.shift.start_dt)


# --- constraints -------------------------------------------------------------

def one_assignment_per_moment(cf: ConstraintFactory) -> Constraint:
    # R1 (hard): an employee fills at most one seat at any one time. Two seats
    # with the same employee whose shifts overlap is physically impossible.
    return (cf.for_each_unique_pair(Seat, Joiners.equal(lambda s: s.employee))
            .filter(lambda a, b: _overlap(a.shift, b.shift))
            .penalize(HardSoftScore.ONE_HARD)
            .as_constraint("R1 one assignment per moment"))


def at_least_one_day_off(cf: ConstraintFactory) -> Constraint:
    # R2 (hard): legal floor of >= 1 day off per calendar week.
    return (cf.for_each(Seat)
            .group_by(lambda s: s.employee,
                      ConstraintCollectors.count_distinct(lambda s: s.shift.start_date))
            .filter(lambda emp, days: days >= DAYS_IN_WEEK)
            .penalize(HardSoftScore.ONE_HARD)
            .as_constraint("R2 at least one day off per week"))


def legal_turnaround_rest(cf: ConstraintFactory) -> Constraint:
    # R3 (hard): minimum legal rest between any two shifts.
    return (cf.for_each_unique_pair(Seat, Joiners.equal(lambda s: s.employee))
            .filter(lambda a, b: not _overlap(a.shift, b.shift)
                    and 0 <= _pair_gap_minutes(a, b) < LEGAL_REST_MINUTES)
            .penalize(HardSoftScore.ONE_HARD)
            .as_constraint("R3 legal turnaround rest"))


def legal_turnaround_rest_carryover(cf: ConstraintFactory) -> Constraint:
    # R3 (hard) across the week boundary, via Carry-over (ADR-0002).
    return (cf.for_each(Seat)
            .filter(lambda s: s.employee.prev_shift_end is not None
                    and 0 <= _gap_minutes(s.employee.prev_shift_end, s.shift.start_dt)
                    < LEGAL_REST_MINUTES)
            .penalize(HardSoftScore.ONE_HARD)
            .as_constraint("R3 legal turnaround rest (carry-over)"))


def understaffing(cf: ConstraintFactory) -> Constraint:
    # R4 (soft): exact demand. A seat left unfilled is an under-staffing Compromise.
    # (Over-staffing cannot occur: demand is modelled as exactly one seat each.)
    return (cf.for_each_including_unassigned(Seat)
            .filter(lambda s: s.employee is None)
            .penalize(HardSoftScore.of_soft(W_UNDERSTAFF))
            .as_constraint("R4 exact demand (understaffing)"))


def at_most_one_shift_per_day(cf: ConstraintFactory) -> Constraint:
    # R5 (soft-strong): at most one shift per calendar (start) day.
    return (cf.for_each(Seat)
            .group_by(lambda s: (s.employee, s.shift.start_date), ConstraintCollectors.count())
            .filter(lambda key, c: c > 1)
            .penalize(HardSoftScore.ONE_SOFT, lambda key, c: W_ONE_SHIFT_PER_DAY * (c - 1))
            .as_constraint("R5 at most one shift per day"))


def night_recovery(cf: ConstraintFactory) -> Constraint:
    # R6 (soft-strong): a long recovery gap after a Night Shift.
    def violation(a: Seat, b: Seat) -> bool:
        if _overlap(a.shift, b.shift):
            return False
        first, second = _ordered(a, b)
        return first.shift.is_night and _pair_gap_minutes(a, b) < NIGHT_REST_MINUTES
    return (cf.for_each_unique_pair(Seat, Joiners.equal(lambda s: s.employee))
            .filter(violation)
            .penalize(HardSoftScore.of_soft(W_NIGHT_RECOVERY))
            .as_constraint("R6 night recovery"))


def night_recovery_carryover(cf: ConstraintFactory) -> Constraint:
    # R6 (soft-strong) across the week boundary, via Carry-over.
    return (cf.for_each(Seat)
            .filter(lambda s: s.employee.prev_shift_was_night
                    and s.employee.prev_shift_end is not None
                    and 0 <= _gap_minutes(s.employee.prev_shift_end, s.shift.start_dt)
                    < NIGHT_REST_MINUTES)
            .penalize(HardSoftScore.of_soft(W_NIGHT_RECOVERY))
            .as_constraint("R6 night recovery (carry-over)"))


def no_consecutive_weekends(cf: ConstraintFactory) -> Constraint:
    # R7 (soft-strong): don't work two weekends in a row (uses Carry-over).
    return (cf.for_each(Seat)
            .filter(lambda s: s.shift.is_weekend and s.employee.worked_last_weekend)
            .group_by(lambda s: s.employee)
            .penalize(HardSoftScore.of_soft(W_CONSECUTIVE_WEEKEND))
            .as_constraint("R7 no consecutive weekends"))


def preferred_second_day_off(cf: ConstraintFactory) -> Constraint:
    # R8 (soft-mild): people prefer a 2nd day off; working 6 days violates it.
    return (cf.for_each(Seat)
            .group_by(lambda s: s.employee,
                      ConstraintCollectors.count_distinct(lambda s: s.shift.start_date))
            .filter(lambda emp, days: days == DAYS_IN_WEEK - 1)
            .penalize(HardSoftScore.of_soft(W_SIXTH_DAY))
            .as_constraint("R8 preferred second day off"))


def fairness_burden(cf: ConstraintFactory) -> Constraint:
    # R9 (soft objective): spread Burden Shifts (night/weekend) evenly, measured
    # cumulatively across weeks via carry-over. Penalising the marginal squared
    # load makes piling burdens on an already-loaded person progressively costly.
    return (cf.for_each(Seat)
            .filter(lambda s: s.is_burden)
            .group_by(lambda s: s.employee, ConstraintCollectors.count())
            .penalize(HardSoftScore.ONE_SOFT,
                      lambda emp, c: W_FAIRNESS
                      * ((c + emp.carryover_burden) ** 2 - emp.carryover_burden ** 2))
            .as_constraint("R9 fairness (burden balance)"))


def respect_preferences(cf: ConstraintFactory) -> Constraint:
    # R10 (soft-mild): avoid shifts the employee asked not to work.
    return (cf.for_each(Seat)
            .filter(lambda s: s.shift.id in s.employee.avoid_shift_ids)
            .penalize(HardSoftScore.of_soft(W_PREFERENCE))
            .as_constraint("R10 respect preferences"))


def exceptional_assignment(cf: ConstraintFactory) -> Constraint:
    # Eligibility-exceeding assignment. The solver can never create one (value
    # range = eligible only); it appears only via a manual Override and is
    # surfaced as a Compromise that needs sign-off.
    return (cf.for_each(Seat)
            .filter(lambda s: not s.is_eligible(s.employee))
            .penalize(HardSoftScore.of_soft(W_EXCEPTIONAL))
            .as_constraint("Exceptional Assignment (needs sign-off)"))


@constraint_provider
def define_constraints(cf: ConstraintFactory) -> list[Constraint]:
    return [
        one_assignment_per_moment(cf),
        at_least_one_day_off(cf),
        legal_turnaround_rest(cf),
        legal_turnaround_rest_carryover(cf),
        understaffing(cf),
        at_most_one_shift_per_day(cf),
        night_recovery(cf),
        night_recovery_carryover(cf),
        no_consecutive_weekends(cf),
        preferred_second_day_off(cf),
        fairness_burden(cf),
        respect_preferences(cf),
        exceptional_assignment(cf),
    ]
