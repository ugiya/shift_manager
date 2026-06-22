"""Validation + conversion of user-supplied requirements documents."""
from __future__ import annotations

import copy

import pytest

from app.data import build_schedule, default_dataset
from app.requirements import (RequirementsIn, dataset_to_requirements, to_dataset,
                              validate_requirements)

# A minimal, fully-valid requirements doc used as a mutation base.
BASE = {
    "sites": [{"id": "s", "name": "S"}],
    "roles": [{"id": "dev", "name": "Dev"}],
    "shift_types": [{"id": "m", "name": "Morning", "start": 8, "end": 16, "is_night": False}],
    "teams": [{"id": "t", "name": "T", "site": "s"}],
    "projects": [{"id": "p", "name": "P", "team": "t"}],
    "employees": [{"id": "e", "name": "E", "team": "t", "roles": ["dev"],
                   "projects": ["p"], "can_manage": True}],
    "demand": [{"team": "t", "shift_type": "m", "days": ["Sun"], "crew": {"p": {"dev": 1}}}],
}


def _validate(doc: dict):
    return validate_requirements(RequirementsIn(**doc))


def test_base_is_valid():
    errors, warnings = _validate(BASE)
    assert errors == []
    assert warnings == []


# --- seed round-trip ---------------------------------------------------------

def test_seed_round_trips_cleanly():
    doc = dataset_to_requirements(default_dataset())
    req = RequirementsIn(**doc)
    errors, warnings = validate_requirements(req)
    assert errors == [], errors
    ds = to_dataset(req)
    assert len(ds.sites) == 4 and len(ds.teams) == 6 and len(ds.employees) == 40
    assert len(build_schedule(ds).seats) == 135


def test_seed_requirements_includes_readonly_config():
    doc = dataset_to_requirements(default_dataset())
    assert doc["config"]["weekend_days"] == ["Fri", "Sat"]
    assert doc["config"]["legal_rest_hours"] == 8


# --- error cases (each mutates the valid BASE) -------------------------------

def _mut(fn):
    d = copy.deepcopy(BASE)
    fn(d)
    return d


def _set_team_bad_site(d): d["teams"][0]["site"] = "nope"
def _set_project_bad_team(d): d["projects"][0]["team"] = "nope"
def _set_emp_bad_team(d): d["employees"][0]["team"] = "nope"
def _set_emp_bad_role(d): d["employees"][0]["roles"] = ["ghost"]
def _set_emp_bad_project(d): d["employees"][0]["projects"] = ["ghost"]
def _set_demand_bad_team(d): d["demand"][0]["team"] = "nope"
def _set_demand_bad_st(d): d["demand"][0]["shift_type"] = "nope"
def _set_demand_no_days(d): d["demand"][0]["days"] = []
def _set_demand_bad_day(d): d["demand"][0]["days"] = ["Funday"]
def _set_crew_bad_project(d): d["demand"][0]["crew"] = {"ghost": {"dev": 1}}
def _set_crew_bad_role(d): d["demand"][0]["crew"] = {"p": {"ghost": 1}}
def _set_crew_zero(d): d["demand"][0]["crew"] = {"p": {"dev": 0}}
def _dup_site(d): d["sites"].append({"id": "s", "name": "dup"})
def _no_sites(d): d["sites"] = []
def _no_teams(d): d["teams"] = []
def _bad_hours(d): d["shift_types"][0]["start"] = 25
def _equal_hours(d): d["shift_types"][0]["end"] = 8
def _neg_carry(d): d["employees"][0]["carryover_burden"] = -2


def _emp_project_not_in_team(d):
    d["teams"].append({"id": "t2", "name": "T2", "site": "s"})
    d["employees"][0]["team"] = "t2"   # project p belongs to t, not t2


ERROR_CASES = [
    (_set_team_bad_site, "unknown site"),
    (_set_project_bad_team, "unknown team"),
    (_set_emp_bad_team, "unknown team"),
    (_set_emp_bad_role, "unknown role"),
    (_set_emp_bad_project, "unknown project"),
    (_emp_project_not_in_team, "not in their team"),
    (_set_demand_bad_team, "unknown team"),
    (_set_demand_bad_st, "unknown shift type"),
    (_set_demand_no_days, "no days"),
    (_set_demand_bad_day, "invalid day"),
    (_set_crew_bad_project, "unknown project"),
    (_set_crew_bad_role, "unknown role"),
    (_set_crew_zero, "≥ 1"),
    (_dup_site, "Duplicate site"),
    (_no_sites, "At least one site"),
    (_no_teams, "At least one team"),
    (_bad_hours, "0–23"),
    (_equal_hours, "must differ"),
    (_neg_carry, "cannot be negative"),
]


@pytest.mark.parametrize("mutate,needle", ERROR_CASES, ids=[c[1] for c in ERROR_CASES])
def test_validation_catches_error(mutate, needle):
    errors, _warnings = _validate(_mut(mutate))
    assert any(needle in e for e in errors), f"expected an error containing {needle!r}; got {errors}"


# --- warning cases (do not block) --------------------------------------------

def test_team_with_demand_but_no_manager_warns():
    d = copy.deepcopy(BASE)
    d["employees"][0]["can_manage"] = False  # now nobody can manage team t
    errors, warnings = _validate(d)
    assert errors == []
    assert any("no shift-manager-eligible" in w for w in warnings)


def test_uncoverable_role_warns():
    d = copy.deepcopy(BASE)
    d["roles"].append({"id": "qa", "name": "QA"})
    d["demand"][0]["crew"] = {"p": {"dev": 1, "qa": 1}}  # no QA employee exists
    errors, warnings = _validate(d)
    assert errors == []
    assert any("No employee can fill qa" in w for w in warnings)


def test_no_demand_warns_not_errors():
    d = copy.deepcopy(BASE)
    d["demand"] = []
    errors, warnings = _validate(d)
    assert errors == []
    assert any("nothing to schedule" in w for w in warnings)


# --- conversion --------------------------------------------------------------

def test_to_dataset_maps_days_to_weekdays():
    d = copy.deepcopy(BASE)
    d["demand"][0]["days"] = ["Sun", "Fri", "Sat"]
    ds = to_dataset(RequirementsIn(**d))
    _team, _st, weekdays, _crew = ds.demand[0]
    assert set(weekdays) == {6, 4, 5}  # Sun=6, Fri=4, Sat=5


def test_to_dataset_builds_solvable_tiny_org():
    ds = to_dataset(RequirementsIn(**BASE))
    sched = build_schedule(ds)
    # one Sunday morning shift: 1 worker seat (dev) + 1 manager seat
    assert len(sched.shifts) == 1
    assert len(sched.seats) == 2
    assert all(seat.eligible for seat in sched.seats)
