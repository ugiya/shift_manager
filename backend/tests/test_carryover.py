"""Carry-over (ADR-0002): the solve is not stateless. Prior-week facts and
cumulative counts feed this week's rules. These pin the carry-over edges."""
from __future__ import annotations

from datetime import timedelta

from conftest import BASE, emp, evaluate, hard_rules, seat, shift_h, soft_rules


def test_worked_last_weekend_without_a_weekend_shift_is_quiet():
    """Carry-over alone raises nothing; it needs a matching assignment this week."""
    a = emp("a", worked_last_weekend=True)
    midweek = shift_h(2 * 24 + 8, 8, id="tue")   # Tuesday, not a weekend
    _score, flags = evaluate([seat(midweek, [a], a)], employees=[a])
    assert "R7" not in soft_rules(flags)


def test_prev_shift_end_far_enough_is_fine():
    a = emp("a", prev_shift_end=BASE + timedelta(hours=0))   # ended Sun 00:00
    sh = shift_h(12, 8, id="s")                              # starts Sun 12:00 (12h later)
    score, flags = evaluate([seat(sh, [a], a)], employees=[a])
    assert score.hard_score == 0
    assert "R3" not in hard_rules(flags)


def test_prev_night_recovery_within_24h_is_soft():
    a = emp("a", prev_shift_was_night=True, prev_shift_end=BASE + timedelta(hours=2))
    sh = shift_h(12, 6, id="s")        # Sun 12:00, 10h after prev night ended (>=8h legal)
    score, flags = evaluate([seat(sh, [a], a)], employees=[a])
    assert score.hard_score == 0
    assert "R6" in soft_rules(flags)


def test_prev_night_recovery_after_24h_is_clear():
    a = emp("a", prev_shift_was_night=True, prev_shift_end=BASE + timedelta(hours=0))
    sh = shift_h(25, 6, id="s")        # 25h after the prev night ended
    _score, flags = evaluate([seat(sh, [a], a)], employees=[a])
    assert "R6" not in soft_rules(flags)


def test_no_carryover_means_no_boundary_flags():
    a = emp("a")  # prev_shift_end None, not worked last weekend
    sh = shift_h(2, 6, id="s")         # very early Sunday shift
    score, flags = evaluate([seat(sh, [a], a)], employees=[a])
    assert score.hard_score == 0
    assert "R3" not in hard_rules(flags) and "R6" not in soft_rules(flags)


def test_carryover_burden_alone_raises_nothing():
    a = emp("a", carryover_burden=5)
    b = emp("b")
    sh = shift_h(2 * 24 + 8, 8, id="tue")   # one ordinary midweek shift
    _score, flags = evaluate([seat(sh, [a], a)], employees=[a, b])
    # high carry-over with no fresh burden imbalance shouldn't, by itself, flag
    assert "R9" not in soft_rules(flags)
