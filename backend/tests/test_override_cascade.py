"""Overrides re-validate the WHOLE Schedule (ADR / CONTEXT).

Each test scores an assignment, mutates a seat (the Override), then re-scores and
checks the flags shifted across the *entire* schedule — not just the edited seat.
"""
from __future__ import annotations

from datetime import timedelta

from conftest import (BASE, day_shift, emp, evaluate, hard_rules, seat, shift_h,
                      soft_rules)


def test_override_can_turn_feasible_into_infeasible_and_back():
    a, b = emp("a"), emp("b")
    sh = shift_h(8, 8)
    s1 = seat(sh, [a, b], a)
    s2 = seat(sh, [a, b], b)
    score, _ = evaluate([s1, s2], employees=[a, b])
    assert score.hard_score == 0

    s2.employee = a                       # override: both on the same shift
    score, flags = evaluate([s1, s2], employees=[a, b])
    assert score.hard_score < 0 and "R1" in hard_rules(flags)

    s2.employee = b                       # revert
    score, _ = evaluate([s1, s2], employees=[a, b])
    assert score.hard_score == 0


def test_clearing_a_seat_creates_understaffing():
    a = emp("a")
    s = seat(day_shift(1, id="mon"), [a], a)
    _score, flags = evaluate([s], employees=[a])
    assert "R4" not in soft_rules(flags)

    s.employee = None                     # override: unassign
    _score, flags = evaluate([s], employees=[a])
    assert "R4" in soft_rules(flags)


def test_filling_an_unstaffed_seat_clears_understaffing():
    a = emp("a")
    s = seat(day_shift(1, id="mon"), [a], None)
    _score, flags = evaluate([s], employees=[a])
    assert "R4" in soft_rules(flags)

    s.employee = a
    _score, flags = evaluate([s], employees=[a])
    assert "R4" not in soft_rules(flags)


def test_exceptional_override_toggles():
    a, b = emp("a"), emp("b")
    s = seat(day_shift(1, id="mon"), [a], a)
    _score, flags = evaluate([s], employees=[a, b])
    assert "EXC" not in soft_rules(flags)

    s.employee = b                        # b not eligible -> exceptional
    _score, flags = evaluate([s], employees=[a, b])
    assert "EXC" in soft_rules(flags)


def test_one_swap_surfaces_several_flags_across_the_week():
    """CONTEXT example: replacing one person can trip multiple rules at once."""
    a = emp("a", worked_last_weekend=True)
    b = emp("b")
    # a already works Sun..Thu (5 days)
    base_seats = [seat(day_shift(d, id=f"d{d}"), [a], a) for d in range(5)]
    sat = seat(day_shift(6, id="sat"), [a, b], b)   # Saturday currently covered by b
    seats = base_seats + [sat]
    _score, flags = evaluate(seats, employees=[a, b])
    assert "R8" not in soft_rules(flags) and "R7" not in soft_rules(flags)

    sat.employee = a                      # override: move Saturday to a
    _score, flags = evaluate(seats, employees=[a, b])
    soft = soft_rules(flags)
    assert "R8" in soft, "a now works 6 days -> preferred 2nd day off lost"
    assert "R7" in soft, "a now works a 2nd consecutive weekend"


def test_swap_removes_one_flag_and_adds_another():
    a, b = emp("a"), emp("b")
    s = seat(day_shift(1, id="mon"), [a], b)        # exceptional (b not eligible)
    _score, flags = evaluate([s], employees=[a, b])
    assert "EXC" in soft_rules(flags) and "R4" not in soft_rules(flags)

    s.employee = None                     # override: unassign the exceptional person
    _score, flags = evaluate([s], employees=[a, b])
    assert "EXC" not in soft_rules(flags) and "R4" in soft_rules(flags)


def test_carryover_rest_violation_surfaces_only_after_override():
    a = emp("a", prev_shift_was_night=True, prev_shift_end=BASE + timedelta(hours=4))
    early = seat(shift_h(8, 4, id="early"), [a], None)   # Sun 08:00 (4h after prev end)
    _score, flags = evaluate([early], employees=[a])
    assert "R3" not in hard_rules(flags)                 # unassigned -> no rest issue

    early.employee = a                                   # override assigns a too soon
    score, flags = evaluate([early], employees=[a])
    assert "R3" in hard_rules(flags) and score.hard_score < 0
