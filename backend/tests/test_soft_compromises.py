"""Soft rules (Compromises): R5, R6, R7, R8, R10, and Exceptional Assignment.

Each must be soft — present in the flags, but never pushing the hard score below 0.
"""
from __future__ import annotations

import pytest

from conftest import (day_shift, emp, evaluate, hard_rules, seat, shift_h, soft_rules)


# --------------------------------------------------------------------------- #
# R5 — at most one shift per calendar day
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("starts,expect_r5", [
    ([24], False),                       # one shift on Monday
    ([24, 34], True),                    # two shifts Monday, 8h apart (legal rest)
    ([24, 34, 44], True),                # three shifts Monday
])
def test_r5_multiple_shifts_same_day(starts, expect_r5):
    a = emp("a")
    seats = [seat(shift_h(s, 2, id=f"s{s}"), [a], a) for s in starts]
    score, flags = evaluate(seats)
    assert ("R5" in soft_rules(flags)) == expect_r5
    assert score.hard_score == 0, "well-spaced same-day shifts are legal, just discouraged"


def test_r5_two_shifts_different_days_is_fine():
    a = emp("a")
    seats = [seat(day_shift(1, id="mon"), [a], a), seat(day_shift(2, id="tue"), [a], a)]
    _score, flags = evaluate(seats)
    assert "R5" not in soft_rules(flags)


# --------------------------------------------------------------------------- #
# R6 — night recovery (within the week)
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("gap_h,expect_r3,expect_r6", [
    (4, True, True),     # too soon: illegal AND under recovery
    (8, False, True),    # legal rest, but still under 24h recovery
    (10, False, True),
    (23, False, True),
    (24, False, False),  # exactly 24h -> recovered
    (30, False, False),
])
def test_r6_night_recovery_boundary(gap_h, expect_r3, expect_r6):
    a = emp("a")
    night = shift_h(22, 8, night=True, id="night")    # Sun 22:00 -> Mon 06:00
    after = shift_h(30 + gap_h, 4, id="after")        # gap_h after night ends
    score, flags = evaluate([seat(night, [a], a), seat(after, [a], a)])
    assert ("R3" in hard_rules(flags)) == expect_r3
    assert ("R6" in soft_rules(flags)) == expect_r6


def test_r6_only_triggers_after_a_night_shift():
    """A non-night shift followed soon after does not trip night recovery."""
    a = emp("a")
    day = shift_h(8, 8, night=False, id="day")        # Sun 08:00-16:00 (not night)
    after = shift_h(28, 4, id="after")                # Mon 04:00 (12h later, legal)
    _score, flags = evaluate([seat(day, [a], a), seat(after, [a], a)])
    assert "R6" not in soft_rules(flags)


# --------------------------------------------------------------------------- #
# R7 — no consecutive weekends
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("worked_last,offset,expect_r7", [
    (True, 6, True),     # worked last weekend + Saturday this week
    (True, 5, True),     # worked last weekend + Friday this week
    (True, 1, False),    # worked last weekend + a Tuesday -> fine
    (False, 6, False),   # fresh + Saturday -> fine
    (False, 5, False),
])
def test_r7_consecutive_weekend(worked_last, offset, expect_r7):
    a = emp("a", worked_last_weekend=worked_last)
    sh = day_shift(offset, id="s")
    score, flags = evaluate([seat(sh, [a], a)], employees=[a])
    assert ("R7" in soft_rules(flags)) == expect_r7
    assert score.hard_score == 0


def test_r7_counts_once_per_employee_even_with_two_weekend_shifts():
    a = emp("a", worked_last_weekend=True)
    fri = day_shift(5, id="fri")
    sat = day_shift(6, id="sat")
    _score, flags = evaluate([seat(fri, [a], a), seat(sat, [a], a)], employees=[a])
    assert len([r for r in soft_rules(flags) if r == "R7"]) == 1


# --------------------------------------------------------------------------- #
# R8 — preferred second day off (working a 6th day)
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("num_days,expect_r8", [
    (4, False), (5, False), (6, True), (7, False),  # 7 is R2-hard, not R8
])
def test_r8_sixth_working_day(num_days, expect_r8):
    a = emp("a")
    seats = [seat(day_shift(d, id=f"d{d}"), [a], a) for d in range(num_days)]
    _score, flags = evaluate(seats)
    assert ("R8" in soft_rules(flags)) == expect_r8


# --------------------------------------------------------------------------- #
# R10 — respect preferences
# --------------------------------------------------------------------------- #

def test_r10_assigned_to_avoided_shift():
    sh = day_shift(1, id="mon")
    a = emp("a", avoid_shift_ids=frozenset({sh.id}))
    score, flags = evaluate([seat(sh, [a], a)], employees=[a])
    assert "R10" in soft_rules(flags)
    assert score.hard_score == 0


def test_r10_not_triggered_for_non_avoided_shift():
    sh = day_shift(1, id="mon")
    other = day_shift(2, id="tue")
    a = emp("a", avoid_shift_ids=frozenset({other.id}))
    _score, flags = evaluate([seat(sh, [a], a)], employees=[a])
    assert "R10" not in soft_rules(flags)


# --------------------------------------------------------------------------- #
# Exceptional Assignment (eligibility-exceeding, override-only)
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("assign_eligible,expect_exc", [(True, False), (False, True)])
def test_exceptional_assignment(assign_eligible, expect_exc):
    a, b = emp("a"), emp("b")
    sh = day_shift(1, id="mon")
    chosen = a if assign_eligible else b
    score, flags = evaluate([seat(sh, [a], chosen)], employees=[a, b])
    assert ("EXC" in soft_rules(flags)) == expect_exc
    assert score.hard_score == 0, "an exceptional assignment is a compromise, not illegal"


def test_exceptional_assignment_cross_team():
    a = emp("a", team="t1")
    outsider = emp("z", team="t2")
    sh = day_shift(1, team="t1", id="mon")
    _score, flags = evaluate([seat(sh, [a], outsider)], employees=[a, outsider])
    assert "EXC" in soft_rules(flags)


def test_exceptional_assignment_wrong_role():
    cashier = emp("cash", roles=("cashier",))
    forklift = emp("fork", roles=("forklift",))
    sh = day_shift(1, id="mon")
    s = seat(sh, [cashier], forklift, role="cashier")  # forklift op in a cashier seat
    _score, flags = evaluate([s], employees=[cashier, forklift])
    assert "EXC" in soft_rules(flags)
