"""Phase 4: shift-TYPE level Preference (R11).

An employee may prefer certain shift TYPES (e.g. Mornings). Being assigned a shift whose
type is NOT among their (non-empty) preferences is a soft Compromise (a PENALTY, never a
reward — a reward would have no flag and break constraints↔analysis parity). An empty
preference set means "no preference" and is never penalised. Coverage (medium) still
outranks it. A preference referencing an unknown shift type is a validation error.
"""
from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

from conftest import day_shift, emp, evaluate, seat
from app.main import app


def rules(flags):
    return [f["rule"] for f in flags]


ORG = {
    "sites": [{"id": "hq", "name": "HQ"}],
    "roles": [{"id": "dev", "name": "Dev"}],
    "shift_types": [
        {"id": "m", "name": "Morning", "start": 8, "end": 16, "is_night": False},
        {"id": "n", "name": "Night", "start": 22, "end": 6, "is_night": True},
    ],
    "teams": [{"id": "a", "name": "Alpha", "site": "hq"}],
    "projects": [{"id": "p", "name": "Apollo", "teams": ["a"]}],
    "employees": [
        {"id": "dana", "name": "Dana", "team": "a", "roles": ["dev"], "projects": ["p"], "can_manage": True},
    ],
    "demand": [{"team": "a", "shift_type": "m", "days": ["Sun"], "crew": {"p": {"dev": 1}}}],
    "week_start": "2026-06-21",
}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def test_unmet_preference_is_penalised_softly():
    a = emp("a", preferred_shift_type_ids=frozenset({"st-morn"}))
    s = seat(day_shift(1, id="night"), [a], a)   # shift type "st-night" — not preferred
    score, flags = evaluate([s], [a])
    assert score.hard_score == 0 and score.medium_score == 0
    assert score.soft_score < 0
    assert "R11" in rules(flags)


def test_met_preference_is_not_penalised():
    a = emp("a", preferred_shift_type_ids=frozenset({"st-morn"}))
    s = seat(day_shift(1, id="morn"), [a], a)    # shift type "st-morn" — preferred
    score, flags = evaluate([s], [a])
    assert "R11" not in rules(flags)
    assert score.soft_score == 0


def test_no_preference_means_no_penalty():
    a = emp("a")                                 # empty preference set
    s = seat(day_shift(1, id="night"), [a], a)
    score, flags = evaluate([s], [a])
    assert "R11" not in rules(flags)
    assert score.soft_score == 0


def test_preference_flag_names_the_shift_type():
    a = emp("a", preferred_shift_type_ids=frozenset({"st-morn"}))
    _score, flags = evaluate([seat(day_shift(1, id="night"), [a], a)], [a])
    r11 = next(f for f in flags if f["rule"] == "R11")
    assert "non-preferred shift type" in r11["title"]
    assert "preferred shift types" in r11["detail"]


def test_coverage_outranks_an_unmet_preference():
    """R11 is soft; coverage R4 is medium. Filling a non-preferred seat (soft penalty) must
    beat leaving it unfilled (medium penalty) — preference can never sacrifice coverage."""
    a = emp("a", preferred_shift_type_ids=frozenset({"st-morn"}))
    filled, _ = evaluate([seat(day_shift(1, id="night"), [a], a)], [a])
    empty, _ = evaluate([seat(day_shift(1, id="night"), [a], None)], [a])
    assert filled.medium_score == 0 and empty.medium_score < 0
    assert (filled.hard_score, filled.medium_score) > (empty.hard_score, empty.medium_score)


def test_unknown_preferred_shift_type_is_a_validation_error(client):
    doc = copy.deepcopy(ORG)
    doc["employees"][0]["preferred_shift_type_ids"] = ["st-ghost"]
    built = client.post("/api/build", json={"requirements": doc}).json()
    assert built["dataset"] is None
    assert any("prefers unknown shift type" in e for e in built["errors"]), built["errors"]


def test_preferred_shift_type_round_trips_through_the_seed_doc(client):
    emp_doc = client.get("/api/requirements").json()["employees"][0]
    assert "preferred_shift_type_ids" in emp_doc
    assert emp_doc["preferred_shift_type_ids"] == []


def test_preferring_multiple_types_including_the_assigned_one_is_not_penalised():
    """Codex: 'all types preferred' (or any superset including the assigned type) ⇒ no penalty."""
    a = emp("a", preferred_shift_type_ids=frozenset({"st-morn", "st-night"}))
    s = seat(day_shift(1, id="night"), [a], a)   # assigned st-night, which IS among prefs
    _score, flags = evaluate([s], [a])
    assert "R11" not in rules(flags)


def test_duplicate_preferred_ids_normalize_as_a_set():
    """Codex (LOW): duplicate preferred ids aren't an error — they normalize to a set in
    to_dataset, consistent with roles/projects. Deliberate, pinned here."""
    from app.requirements import RequirementsIn, to_dataset, validate_requirements
    doc = copy.deepcopy(ORG)
    doc["employees"][0]["preferred_shift_type_ids"] = ["m", "m"]
    errors, _ = validate_requirements(RequirementsIn(**doc))
    assert errors == []                                  # duplicates allowed
    dana = next(e for e in to_dataset(RequirementsIn(**doc)).employees if e.id == "dana")
    assert dana.preferred_shift_type_ids == frozenset({"m"})


def test_unavailable_override_onto_non_preferred_type_stacks_exc_and_r11():
    """Codex: an unavailable override onto a non-preferred type is BOTH an Exceptional
    Assignment (ineligible) and an unmet preference — the two compromises stack."""
    from datetime import timedelta
    from conftest import WEEK_SUN
    mon = WEEK_SUN + timedelta(days=1)
    a = emp("a", unavailable_dates=frozenset({mon}), preferred_shift_type_ids=frozenset({"st-morn"}))
    s = seat(day_shift(1, id="night"), [], a)            # ineligible (unavailable) + non-preferred type
    _score, flags = evaluate([s], [a])
    rs = rules(flags)
    assert "EXC" in rs and "R11" in rs


def test_preference_survives_build_and_solve(client):
    """End-to-end: an employee preferring Mornings, with only Night demand, solves feasibly
    (R11 is soft, never blocks) and surfaces the R11 compromise in the flags."""
    doc = copy.deepcopy(ORG)
    doc["demand"] = [{"team": "a", "shift_type": "n", "days": ["Sun"], "crew": {"p": {"dev": 1}}}]
    doc["employees"][0]["preferred_shift_type_ids"] = ["m"]   # prefers Morning, only Night exists
    solved = client.post("/api/solve", json={"requirements": doc, "seconds": 2}).json()
    assert solved["score"]["feasible"] is True
    assert any(f["rule"] == "R11" for f in solved["flags"]), solved["flags"]
