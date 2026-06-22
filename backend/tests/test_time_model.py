"""The time model from CONTEXT.md:
  * a Shift is COUNTED on the calendar day it STARTS;
  * REST is measured by real clock time (it may cross midnight);
  * "night" is an explicit classification flag, never inferred from the hours;
  * "weekend" keys off the start day.
"""
from __future__ import annotations

from conftest import day_shift, emp, evaluate, hard_rules, seat, shift_h, soft_rules


# --- count by START day ------------------------------------------------------

def test_night_shift_is_counted_on_its_start_day():
    """Night Sun 22:00->Mon 06:00 + a Sunday morning shift = two shifts on Sunday."""
    a = emp("a")
    night = shift_h(22, 8, night=True, id="night")     # starts Sunday
    sun_morning = shift_h(8, 6, id="sun-am")           # Sunday 08:00-14:00
    _score, flags = evaluate([seat(night, [a], a), seat(sun_morning, [a], a)])
    assert "R5" in soft_rules(flags), "both shifts start on Sunday -> one-per-day tripped"


def test_night_shift_does_not_borrow_its_end_day():
    """Same night, but paired with a MONDAY shift -> different start days, no R5."""
    a = emp("a")
    night = shift_h(22, 8, night=True, id="night")     # Sun 22:00 -> Mon 06:00
    mon_evening = shift_h(24 + 16, 6, id="mon-pm")      # Mon 16:00 (>=8h after 06:00)
    _score, flags = evaluate([seat(night, [a], a), seat(mon_evening, [a], a)])
    assert "R5" not in soft_rules(flags)


# --- rest measured by clock, across midnight ---------------------------------

def test_rest_is_measured_in_clock_time_across_midnight():
    a = emp("a")
    night = shift_h(22, 8, night=True, id="night")     # ends Mon 06:00
    too_soon = shift_h(24 + 9, 4, id="soon")            # Mon 09:00 -> 3h gap
    score, flags = evaluate([seat(night, [a], a), seat(too_soon, [a], a)])
    assert "R3" in hard_rules(flags)
    assert score.hard_score < 0


# --- weekend keys off the START day ------------------------------------------

def test_weekend_is_determined_by_start_day():
    assert day_shift(5, id="fri").is_weekend is True    # Friday
    assert day_shift(6, id="sat").is_weekend is True    # Saturday
    assert day_shift(4, id="thu").is_weekend is False   # Thursday
    # a shift that starts Friday night and ends Saturday is a weekend shift
    assert shift_h(5 * 24 + 23, 4, id="fri-late").is_weekend is True
    # a shift that starts Thursday night and ends Friday is NOT (starts Thursday)
    assert shift_h(4 * 24 + 23, 4, id="thu-late").is_weekend is False


# --- "night" is explicit, never inferred from hours --------------------------

def test_night_classification_is_explicit_not_inferred():
    a, b = emp("a"), emp("b")
    # identical hours (22:00-06:00) but only one is classified as night
    classified = shift_h(22, 8, night=True, id="classified")
    not_classified = shift_h(22, 8, night=False, id="plain")
    follow1 = shift_h(30 + 10, 4, id="f1")   # 10h after the first ends
    follow2 = shift_h(30 + 10, 4, id="f2")

    _s1, flags_night = evaluate([seat(classified, [a], a), seat(follow1, [a], a)])
    _s2, flags_plain = evaluate([seat(not_classified, [b], b), seat(follow2, [b], b)])

    assert "R6" in soft_rules(flags_night), "classified night triggers recovery rule"
    assert "R6" not in soft_rules(flags_plain), "same hours, not classified -> no recovery rule"
