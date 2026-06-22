"""R9 — fairness: burden shifts (night/weekend) spread evenly, scoped per team,
measured cumulatively across weeks via carry-over."""
from __future__ import annotations

from conftest import emp, evaluate, seat, shift_h, soft_rules


def night_seats(a, offsets, team="t1"):
    """One night shift per offset, all assigned to `a` (each is a Burden Shift)."""
    return [
        seat(shift_h(o * 24 + 22, 8, night=True, team=team, id=f"n-{a.id}-{o}"),
             [a], a, project="p", role="r")
        for o in offsets
    ]


def test_fairness_flag_when_burden_is_lopsided():
    a, b = emp("a"), emp("b")
    seats = night_seats(a, [0, 2, 4])  # a carries 3 nights, b carries none
    score, flags = evaluate(seats, employees=[a, b])
    assert "R9" in soft_rules(flags)


def test_no_fairness_flag_when_burden_is_balanced():
    a, b = emp("a"), emp("b")
    seats = night_seats(a, [0]) + night_seats(b, [2])  # one night each
    _score, flags = evaluate(seats, employees=[a, b])
    assert "R9" not in soft_rules(flags)


def test_carryover_burden_counts_toward_fairness():
    # equal this-week load, but `a` already carries 3 burdens from prior weeks
    a = emp("a", carryover_burden=3)
    b = emp("b")
    seats = night_seats(a, [0]) + night_seats(b, [2])
    _score, flags = evaluate(seats, employees=[a, b])
    assert "R9" in soft_rules(flags), "cumulative carry-over imbalance must surface"


def test_weekend_shifts_are_burden_for_fairness():
    a, b = emp("a"), emp("b")
    # two weekend shifts (Fri, Sat) both on `a`
    fri = shift_h(5 * 24 + 8, 8, id="fri")
    sat = shift_h(6 * 24 + 8, 8, id="sat")
    _score, flags = evaluate([seat(fri, [a], a), seat(sat, [a], a)], employees=[a, b])
    assert "R9" in soft_rules(flags)


def test_fairness_is_scoped_per_team():
    # team t1 is lopsided; team t2 is balanced -> exactly one fairness flag (t1)
    a, b = emp("a", team="t1"), emp("b", team="t1")
    c, d = emp("c", team="t2"), emp("d", team="t2")
    seats = (night_seats(a, [0, 2], team="t1")          # t1: a=2, b=0  -> imbalance
             + night_seats(c, [0], team="t2")           # t2: c=1, d=1  -> balanced
             + night_seats(d, [2], team="t2"))
    _score, flags = evaluate(seats, employees=[a, b, c, d])
    r9 = [f for f in flags if f["rule"] == "R9"]
    assert len(r9) == 1
    assert "t1" in r9[0]["title"] and "t2" not in r9[0]["title"]
