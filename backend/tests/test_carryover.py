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


def test_prev_shift_overlapping_current_is_a_hard_cross_boundary_overlap():
    """A prior-week shift ending AFTER a current shift starts (negative gap) is a
    cross-boundary overlap: hard R3. R1 can't catch it — last week's shift isn't a
    Seat in this Schedule. (Reproduced blocker #1.)"""
    a = emp("a", prev_shift_end=BASE + timedelta(hours=6))   # last week ended Sun 06:00
    sh = shift_h(2, 6, id="s")                               # current starts Sun 02:00
    score, flags = evaluate([seat(sh, [a], a)], [a])
    assert score.hard_score < 0
    assert "R3" in hard_rules(flags)
    assert "Overlaps" in next(f["detail"] for f in flags if f["rule"] == "R3")


def test_prev_night_overlap_also_flags_soft_recovery():
    a = emp("a", prev_shift_was_night=True, prev_shift_end=BASE + timedelta(hours=6))
    sh = shift_h(2, 6, id="s")
    score, flags = evaluate([seat(sh, [a], a)], [a])
    assert "R3" in hard_rules(flags)     # the overlap is hard
    assert "R6" in soft_rules(flags)     # and a night-recovery compromise


def test_carryover_rest_is_per_seat_and_matches_the_authoritative_score():
    """Parity (#5): constraints (Timefold) and analysis both pair last week's shift
    with EACH current-week seat. Two current shifts within legal rest of the prior
    end => 2 carry-over R3 + 1 within-week R3, and the hard score counts the same 3."""
    a = emp("a", prev_shift_end=BASE)        # last week ended Sun 00:00
    s1 = shift_h(2, 3, id="s1")              # Sun 02:00-05:00 (gap 2h from prev)
    s2 = shift_h(6, 3, id="s2")              # Sun 06:00-09:00 (gap 6h from prev)
    score, flags = evaluate([seat(s1, [a], a), seat(s2, [a], a)], [a])
    r3_hard = [f for f in flags if f["rule"] == "R3" and f["kind"] == "hard"]
    assert len(r3_hard) == 3
    assert score.hard_score == -3           # analysis flag count == Timefold hard matches
