"""Timefold is the scoring authority; the derived flags are the explanation.

These assert the two never disagree on feasibility, and that constraint metadata
and the score breakdown are well-formed.
"""
from __future__ import annotations

import pytest

from conftest import day_shift, emp, evaluate, hard_rules, seat, shift_h


def s_legal_single():
    a = emp("a")
    return [seat(day_shift(1, id="x"), [a], a)], [a]


def s_double_book():
    a = emp("a")
    sh = shift_h(8, 8)
    return [seat(sh, [a], a), seat(sh, [a], a)], [a]


def s_no_day_off():
    a = emp("a")
    return [seat(day_shift(d, id=f"d{d}"), [a], a) for d in range(7)], [a]


def s_short_rest():
    a = emp("a")
    return [seat(shift_h(20, 4, id="s1"), [a], a), seat(shift_h(26, 4, id="s2"), [a], a)], [a]


def s_exceptional_soft():
    a, b = emp("a"), emp("b")
    return [seat(day_shift(1, id="x"), [a], b)], [a, b]


def s_night_recovery_soft():
    a = emp("a")
    return [seat(shift_h(22, 8, night=True, id="n"), [a], a),
            seat(shift_h(40, 4, id="f"), [a], a)], [a]


def s_consecutive_weekend_soft():
    a = emp("a", worked_last_weekend=True)
    return [seat(day_shift(6, id="s"), [a], a)], [a]


def s_understaffed_soft():
    a = emp("a")
    return [seat(day_shift(1, id="x"), [a], None)], [a]


FEASIBLE = [s_legal_single, s_exceptional_soft, s_night_recovery_soft,
            s_consecutive_weekend_soft, s_understaffed_soft]
INFEASIBLE = [s_double_book, s_no_day_off, s_short_rest]


@pytest.mark.parametrize("builder", FEASIBLE, ids=lambda f: f.__name__)
def test_feasible_scenarios_agree(builder):
    seats, employees = builder()
    score, flags = evaluate(seats, employees)
    assert score.hard_score == 0
    assert hard_rules(flags) == []


@pytest.mark.parametrize("builder", INFEASIBLE, ids=lambda f: f.__name__)
def test_infeasible_scenarios_agree(builder):
    seats, employees = builder()
    score, flags = evaluate(seats, employees)
    assert score.hard_score < 0
    assert hard_rules(flags) != []


@pytest.mark.parametrize("builder", [s_exceptional_soft, s_night_recovery_soft,
                                     s_consecutive_weekend_soft, s_understaffed_soft],
                         ids=lambda f: f.__name__)
def test_soft_only_scenarios_are_feasible_but_report_a_compromise(builder):
    seats, employees = builder()
    score, flags = evaluate(seats, employees)
    assert score.hard_score == 0
    assert score.soft_score < 0
    assert [f for f in flags if f["kind"] == "soft"] != []


def test_constraint_metadata_is_well_formed():
    from app.constraints import CONSTRAINTS
    assert CONSTRAINTS, "registry must not be empty"
    for name, meta in CONSTRAINTS.items():
        assert meta["kind"] in ("hard", "soft"), name
        assert meta["rule"]


def test_score_breakdown_shape_and_known_constraints(default_solution):
    _ds, solved, _lk = default_solution
    from app.constraints import CONSTRAINTS
    from app.solver import score_breakdown
    bd = score_breakdown(solved)
    assert set(bd) >= {"score", "hard_score", "soft_score", "feasible", "constraints"}
    assert isinstance(bd["constraints"], list)
    for c in bd["constraints"]:
        assert c["name"] in CONSTRAINTS, f"unmapped constraint surfaced: {c['name']}"
        assert c["kind"] in ("hard", "soft")
