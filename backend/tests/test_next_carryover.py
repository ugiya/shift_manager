"""next_week_carryover (ADR-0002 continuity seam): the accepted Schedule for one
week derives the next week's carry-over seed. These pin the derivation edges;
test_api_carryover proves the seed actually round-trips through the public API."""
from __future__ import annotations

from app.carryover import next_week_carryover
from app.domain import Schedule
from app.requirements import CARRYOVER_FIELDS, CarryoverFields, EmployeeIn
from conftest import day_shift, emp, seat


def _schedule(seats, employees):
    shifts = list({s.shift.id: s.shift for s in seats}.values())
    return Schedule(list(employees), shifts, list(seats))


def test_last_shift_drives_prev_shift_end_and_night_flag():
    a = emp("a", carryover_burden=2)
    fri_night = day_shift(5, start=22, dur=8, night=True, id="fri")  # Fri 22:00 -> Sat 06:00
    tue_day = day_shift(2, start=8, dur=8, id="tue")                 # Tue 08:00 -> 16:00
    sched = _schedule([seat(fri_night, [a], a), seat(tue_day, [a], a)], [a])
    co = next_week_carryover(sched)["a"]
    assert co["prev_shift_end"] == fri_night.end_dt.isoformat()
    assert co["prev_shift_end"].endswith("T06:00:00")   # local-naive, no offset
    assert co["prev_shift_was_night"] is True
    assert co["worked_last_weekend"] is True
    assert co["carryover_burden"] == 3                  # 2 prior + 1 burden (the Fri night)


def test_last_shift_is_chosen_by_end_time_not_night_priority():
    a = emp("a")
    sun_night = day_shift(0, start=0, dur=6, night=True, id="sun")   # Sun 00:00 -> 06:00 (night)
    thu_day = day_shift(4, start=8, dur=8, id="thu")                 # Thu 08:00 -> 16:00 (later)
    sched = _schedule([seat(sun_night, [a], a), seat(thu_day, [a], a)], [a])
    co = next_week_carryover(sched)["a"]
    assert co["prev_shift_end"] == thu_day.end_dt.isoformat()
    assert co["prev_shift_was_night"] is False          # the latest-ending shift wins
    assert co["carryover_burden"] == 1                  # the Sun night is still a burden


def test_unworked_employee_carries_burden_forward_only():
    a = emp("a", carryover_burden=4)
    sched = _schedule([], [a])
    assert next_week_carryover(sched)["a"] == {
        "carryover_burden": 4,
        "worked_last_weekend": False,
        "prev_shift_end": None,
        "prev_shift_was_night": False,
    }


def test_weekday_only_week_clears_weekend_and_night():
    a = emp("a")
    mon = day_shift(1, start=8, dur=8, id="mon")
    sched = _schedule([seat(mon, [a], a)], [a])
    co = next_week_carryover(sched)["a"]
    assert co["worked_last_weekend"] is False
    assert co["prev_shift_was_night"] is False
    assert co["prev_shift_end"] == mon.end_dt.isoformat()
    assert co["carryover_burden"] == 0


def test_every_employee_is_present_in_the_seed():
    a = emp("a")
    b = emp("b")
    sh = day_shift(1, id="mon")
    sched = _schedule([seat(sh, [a], a)], [a, b])
    co = next_week_carryover(sched)
    assert set(co) == {"a", "b"}            # b worked nothing but is still seeded
    assert co["b"]["prev_shift_end"] is None


def test_carryover_shape_is_single_sourced():
    """N1 drift guard: the four carry-over fields are identical across the seed
    output, the shared CarryoverFields model, and CARRYOVER_FIELDS, and each is a
    real EmployeeIn field — so input, output and the seed envelope cannot drift."""
    a = emp("a")
    seed_keys = set(next_week_carryover(_schedule([], [a]))["a"])
    model_keys = set(CarryoverFields.model_fields)
    assert seed_keys == model_keys == set(CARRYOVER_FIELDS)
    assert model_keys <= set(EmployeeIn.model_fields)   # each entry pastes onto an employee


def test_mixed_night_tie_reports_night_conservatively():
    """When two shifts tie on the latest end time and only one is a night, report a
    night (conservative): the next week owes the longer recovery (N4)."""
    a = emp("a")
    day = day_shift(1, start=8, dur=8, id="d-day")                  # Mon 08:00-16:00
    night = day_shift(1, start=8, dur=8, night=True, id="d-night")  # same window, night
    co = next_week_carryover(_schedule([seat(day, [a], a), seat(night, [a], a)], [a]))["a"]
    assert co["prev_shift_was_night"] is True


def test_same_end_time_resolves_deterministically():
    """Two shifts sharing an end time (the (end_dt, start_dt, id) tie-break is part
    of the contract): the seed is stable across calls."""
    a = emp("a")
    s1 = day_shift(1, start=8, dur=8, id="mon-a")
    s2 = day_shift(1, start=8, dur=8, id="mon-b")   # identical window, different id
    sched = _schedule([seat(s1, [a], a), seat(s2, [a], a)], [a])
    co1 = next_week_carryover(sched)["a"]
    co2 = next_week_carryover(sched)["a"]
    assert co1 == co2
    assert co1["prev_shift_end"] == s1.end_dt.isoformat()
