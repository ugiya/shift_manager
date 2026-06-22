"""Hard core (Infeasibilities): R1 one-seat-per-moment, R2 >=1 day off, R3 rest.

The hard core is the only thing the optimizer will never knowingly break, so each
boundary is pinned tightly.
"""
from __future__ import annotations

import pytest

from conftest import (day_shift, emp, evaluate, hard_rules, seat, shift_h)


# --------------------------------------------------------------------------- #
# R1 — one assignment per moment
# --------------------------------------------------------------------------- #

def test_r1_same_shift_two_seats_same_person():
    a = emp("a")
    sh = shift_h(8, 8)
    score, flags = evaluate([seat(sh, [a], a), seat(sh, [a], a)])
    assert score.hard_score < 0
    assert "R1" in hard_rules(flags)


@pytest.mark.parametrize(
    "start_a,dur_a,start_b,dur_b,overlap",
    [
        (10, 8, 10, 8, True),    # identical times, different shifts
        (10, 8, 17, 8, True),    # b starts before a ends
        (10, 8, 18, 8, False),   # exactly adjacent (a ends == b starts)
        (10, 8, 9, 8, True),     # b straddles a's start
        (10, 8, 26, 8, False),   # next day, clearly separate
        (46, 8, 50, 8, True),    # night crossing midnight (Mon22-Tue06) overlaps Tue02-Tue10
        (46, 8, 54, 8, False),   # night then exactly-adjacent morning
    ],
)
def test_r1_overlap_detection(start_a, dur_a, start_b, dur_b, overlap):
    # R1 fires iff the two shifts overlap in time. (Merely adjacent shifts don't
    # overlap, though a 0-gap turnaround is separately an R3 rest violation —
    # so we assert only on R1 here, not on overall feasibility.)
    a = emp("a")
    sa = shift_h(start_a, dur_a, id="sa")
    sb = shift_h(start_b, dur_b, id="sb")
    score, flags = evaluate([seat(sa, [a], a), seat(sb, [a], a)])
    assert ("R1" in hard_rules(flags)) == overlap
    if overlap:
        assert score.hard_score < 0


def test_r1_different_employees_overlapping_is_fine():
    a, b = emp("a"), emp("b")
    sh = shift_h(8, 8)
    score, flags = evaluate([seat(sh, [a, b], a), seat(sh, [a, b], b)])
    assert score.hard_score == 0
    assert "R1" not in hard_rules(flags)


def test_r1_three_overlapping_seats_same_person_all_flagged():
    a = emp("a")
    sh = shift_h(8, 8)
    _score, flags = evaluate([seat(sh, [a], a), seat(sh, [a], a), seat(sh, [a], a)])
    # three mutually overlapping seats -> three pairwise R1 incidents
    assert len([r for r in hard_rules(flags) if r == "R1"]) == 3


# --------------------------------------------------------------------------- #
# R2 — at least one day off per calendar week
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("num_days,expect_r2", [
    (1, False), (2, False), (5, False), (6, False), (7, True),
])
def test_r2_days_worked(num_days, expect_r2):
    a = emp("a")
    seats = [seat(day_shift(d, id=f"d{d}"), [a], a) for d in range(num_days)]
    score, flags = evaluate(seats)
    assert ("R2" in hard_rules(flags)) == expect_r2
    assert (score.hard_score < 0) == expect_r2


def test_r2_seven_shifts_but_six_distinct_days_is_legal():
    """Two shifts on one day still leaves a day off elsewhere -> no R2."""
    a = emp("a")
    seats = [seat(day_shift(d, id=f"d{d}"), [a], a) for d in range(1, 6)]  # Mon..Fri (5 days)
    # double up Sunday with two shifts a legal 8h apart -> 6 distinct days, 7 shifts
    seats.append(seat(shift_h(0, 4, id="sun-am"), [a], a))   # Sun 00:00-04:00
    seats.append(seat(shift_h(12, 4, id="sun-pm"), [a], a))  # Sun 12:00-16:00 (8h gap)
    score, flags = evaluate(seats)
    assert "R2" not in hard_rules(flags)
    assert score.hard_score == 0


def test_r2_full_week_with_doubles_still_hard():
    a = emp("a")
    seats = [seat(day_shift(d, id=f"d{d}"), [a], a) for d in range(7)]  # Sun..Sat
    score, flags = evaluate(seats)
    assert "R2" in hard_rules(flags)


# --------------------------------------------------------------------------- #
# R3 — legal turnaround rest (within the week)
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("gap_h,expect_hard", [
    (4, True), (6, True), (7.5, True), (7.99, True),
    (8, False), (8.01, False), (9, False), (12, False), (16, False),
])
def test_r3_rest_gap_boundary(gap_h, expect_hard):
    a = emp("a")
    first = shift_h(20, 4, id="first")            # Sun 20:00 -> Mon 00:00
    second = shift_h(24 + gap_h, 4, id="second")  # Mon, gap_h after first ends
    score, flags = evaluate([seat(first, [a], a), seat(second, [a], a)])
    assert ("R3" in hard_rules(flags)) == expect_hard
    assert (score.hard_score < 0) == expect_hard


@pytest.mark.parametrize("gap_h,expect_hard", [
    (1, True), (4, True), (7.99, True), (8, False), (10, False), (24, False),
])
def test_r3_carryover_across_week_boundary(gap_h, expect_hard):
    from conftest import BASE
    from datetime import timedelta
    prev_end = BASE + timedelta(hours=6)          # ended at Sun 06:00 (carry-over)
    a = emp("a", prev_shift_end=prev_end)
    sh = shift_h(6 + gap_h, 4, id="s")
    score, flags = evaluate([seat(sh, [a], a)], employees=[a])
    assert ("R3" in hard_rules(flags)) == expect_hard


def test_r3_no_false_positive_for_well_separated_shifts():
    a = emp("a")
    s1 = day_shift(0, start=8, dur=8, id="s1")    # Sun 08-16
    s2 = day_shift(2, start=8, dur=8, id="s2")    # Tue 08-16
    score, flags = evaluate([seat(s1, [a], a), seat(s2, [a], a)])
    assert score.hard_score == 0
    assert "R3" not in hard_rules(flags)
